/**
 * D1 reader / writer for the user-administration surface
 * (`/api/v1/publish/publishers/**`). Mirrors the shape of
 * `dataset-mutations.ts`: pure store functions returning discriminated
 * outcomes, with the route handlers owning HTTP concerns and
 * field-level validation.
 *
 * All callers are admin-gated upstream (`isAdmin()` in the route), so
 * these functions assume the caller is privileged and focus on the
 * data rules — cursor pagination, partial updates, and the two
 * guardrails that keep an admin from locking everyone (or themselves)
 * out:
 *
 *   - self-lockout — an admin cannot demote their own account out of
 *     `admin`, nor suspend themselves.
 *   - last-admin — the final active admin cannot be demoted or
 *     suspended, so a deploy always has at least one administrator.
 *
 * `is_admin` is kept synced with `role` on every write (the column is
 * a legacy mirror of `role === 'admin'`; see `publisher-store.ts`).
 */

import { type PublisherRow } from './publisher-store'
import { writePublisherAudit } from './audit-store'
import type { AuditAction } from './audit-store'

export interface PublisherListOptions {
  /** Filter by status. Omit for all statuses. */
  status?: string
  /** Filter by role. Omit for all roles. */
  role?: string
  /** Case-insensitive substring match on email or display name. */
  q?: string
  /** Opaque cursor — the last id from the previous page. */
  cursor?: string
  /** Page size, clamped to [1, 200]; defaults to 50. */
  limit?: number
}

/**
 * List publishers with optional status/role/text filters and
 * cursor-based pagination. Ordered by ULID `id` ascending, the same
 * `LIMIT n+1` look-ahead trick as `listDatasetsForPublisher`.
 */
export async function listPublishers(
  db: D1Database,
  options: PublisherListOptions = {},
): Promise<{ publishers: PublisherRow[]; next_cursor: string | null }> {
  const where: string[] = []
  const binds: unknown[] = []

  if (options.status) {
    where.push('status = ?')
    binds.push(options.status)
  }
  if (options.role) {
    where.push('role = ?')
    binds.push(options.role)
  }
  if (options.q) {
    where.push('(LOWER(email) LIKE ? OR LOWER(display_name) LIKE ?)')
    const needle = `%${options.q.toLowerCase()}%`
    binds.push(needle, needle)
  }
  if (options.cursor) {
    where.push('id > ?')
    binds.push(options.cursor)
  }

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const sql = `SELECT * FROM publishers ${whereSql} ORDER BY id ASC LIMIT ?`
  const result = await db
    .prepare(sql)
    .bind(...binds, limit + 1)
    .all<PublisherRow>()
  const rows = result.results ?? []
  const hasMore = rows.length > limit
  const publishers = hasMore ? rows.slice(0, limit) : rows
  const next_cursor = hasMore ? publishers[publishers.length - 1].id : null
  return { publishers, next_cursor }
}

/** Fetch a single publisher by id, or null if absent. */
export async function getPublisher(db: D1Database, id: string): Promise<PublisherRow | null> {
  const row = await db
    .prepare('SELECT * FROM publishers WHERE id = ? LIMIT 1')
    .bind(id)
    .first<PublisherRow>()
  return row ?? null
}

/**
 * Count active admins, optionally excluding one id. Drives the
 * last-admin guardrail: before demoting / suspending an admin we
 * check that at least one other active admin remains.
 */
export async function countActiveAdmins(db: D1Database, exceptId?: string): Promise<number> {
  const sql = exceptId
    ? `SELECT COUNT(*) AS n FROM publishers WHERE role = 'admin' AND status = 'active' AND id != ?`
    : `SELECT COUNT(*) AS n FROM publishers WHERE role = 'admin' AND status = 'active'`
  const row = exceptId
    ? await db.prepare(sql).bind(exceptId).first<{ n: number }>()
    : await db.prepare(sql).first<{ n: number }>()
  return row?.n ?? 0
}

export interface PublisherUpdatePayload {
  role?: string
  status?: string
  display_name?: string
  affiliation?: string | null
}

export type PublisherUpdateOutcome =
  | { ok: true; status: number; publisher: PublisherRow }
  | { ok: false; status: number; error: string; message: string }

/**
 * Resolve the audit action a status transition represents. Returns
 * null when the status did not change.
 */
function statusAuditAction(prev: string, next: string): AuditAction | null {
  if (prev === next) return null
  if (next === 'active') return prev === 'suspended' ? 'publisher.reactivate' : 'publisher.approve'
  if (next === 'suspended') return prev === 'pending' ? 'publisher.reject' : 'publisher.suspend'
  return 'publisher.role_change'
}

/**
 * Apply a partial update to a publisher row. Enforces the
 * self-lockout and last-admin guardrails, keeps `is_admin` synced to
 * the resulting role, and writes a best-effort audit row describing
 * the change. `actor` is the admin performing the update.
 */
export async function updatePublisher(
  db: D1Database,
  id: string,
  patch: PublisherUpdatePayload,
  actor: PublisherRow,
): Promise<PublisherUpdateOutcome> {
  const existing = await getPublisher(db, id)
  if (!existing) {
    return { ok: false, status: 404, error: 'not_found', message: `Publisher ${id} not found.` }
  }

  const nextRole = patch.role ?? existing.role
  const nextStatus = patch.status ?? existing.status
  const isSelf = id === actor.id

  // self-lockout: the acting admin cannot strip their own admin role
  // or suspend themselves, which would lock them out mid-session.
  const removingOwnAdmin = isSelf && existing.role === 'admin' && nextRole !== 'admin'
  const suspendingSelf = isSelf && nextStatus === 'suspended'
  if (removingOwnAdmin || suspendingSelf) {
    return {
      ok: false,
      status: 409,
      error: 'self_lockout',
      message: 'You cannot remove your own admin role or suspend your own account.',
    }
  }

  // last-admin: never leave the deploy with zero active admins. Will
  // this update demote or deactivate the currently-only active admin?
  const loseAdmin =
    existing.role === 'admin' &&
    existing.status === 'active' &&
    (nextRole !== 'admin' || nextStatus !== 'active')

  const sets: string[] = []
  const binds: unknown[] = []
  if (patch.role !== undefined) {
    sets.push('role = ?')
    binds.push(patch.role)
    // Keep the legacy is_admin mirror in lockstep with the new role.
    sets.push('is_admin = ?')
    binds.push(patch.role === 'admin' ? 1 : 0)
  }
  if (patch.status !== undefined) {
    sets.push('status = ?')
    binds.push(patch.status)
  }
  if (patch.display_name !== undefined) {
    sets.push('display_name = ?')
    binds.push(patch.display_name)
  }
  if (patch.affiliation !== undefined) {
    sets.push('affiliation = ?')
    binds.push(patch.affiliation)
  }

  if (sets.length === 0) {
    return { ok: false, status: 400, error: 'no_changes', message: 'No updatable fields supplied.' }
  }

  // Fold the last-admin guard into the UPDATE itself rather than a
  // separate count read, so two concurrent demote/suspend requests
  // can't both pass a stale check and strand the deploy with zero
  // admins (TOCTOU). The EXISTS clause keeps the write a no-op unless
  // another active admin remains; `changes === 0` then means the
  // guard fired.
  binds.push(id)
  let where = 'id = ?'
  if (loseAdmin) {
    where += " AND EXISTS (SELECT 1 FROM publishers WHERE role = 'admin' AND status = 'active' AND id != ?)"
    binds.push(id)
  }
  const result = await db
    .prepare(`UPDATE publishers SET ${sets.join(', ')} WHERE ${where}`)
    .bind(...binds)
    .run()
  if (loseAdmin && (result.meta?.changes ?? 0) === 0) {
    return {
      ok: false,
      status: 409,
      error: 'last_admin',
      message: 'Cannot demote or suspend the last active admin.',
    }
  }

  const updated = await getPublisher(db, id)
  // Re-read should always succeed (we just updated an existing row),
  // but fall back to a synthesized view rather than throwing.
  const publisher: PublisherRow = updated ?? {
    ...existing,
    role: nextRole,
    status: nextStatus,
    is_admin: nextRole === 'admin' ? 1 : 0,
    display_name: patch.display_name ?? existing.display_name,
    affiliation: patch.affiliation !== undefined ? patch.affiliation : existing.affiliation,
  }

  // Audit only the security-relevant transitions (status / role).
  // A profile-only edit (display_name / affiliation) writes no audit
  // row — labelling it `publisher.role_change` would be misleading.
  const statusChanged = existing.status !== publisher.status
  const roleChanged = existing.role !== publisher.role
  const action = statusAuditAction(existing.status, publisher.status) ?? (roleChanged ? 'publisher.role_change' : null)
  if (action && (statusChanged || roleChanged)) {
    await writePublisherAudit(db, actor, action, id, {
      role: { from: existing.role, to: publisher.role },
      status: { from: existing.status, to: publisher.status },
    })
  }

  return { ok: true, status: 200, publisher }
}
