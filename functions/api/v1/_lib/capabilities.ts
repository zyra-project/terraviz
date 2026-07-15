/**
 * Server-side capability check for the publisher API.
 *
 * Thin adapter over the shared, dependency-free role→capability matrix
 * in `src/types/publisher-roles.ts` (the single source of truth, also
 * imported by the portal). Route handlers and mutation helpers gate on
 * `can(publisher, cap)` rather than `role === '...'`.
 *
 * Design: `docs/PUBLISHER_ROLES_PLAN.md`.
 */

import type { PublisherRow } from './publisher-store'
import { type Capability, roleCan } from '../../../../src/types/publisher-roles'

export type { Capability }

/** Whether `publisher` holds `cap`. */
export function can(publisher: PublisherRow, cap: Capability): boolean {
  return roleCan(publisher.role, cap)
}

/**
 * Ownership-composed check: `publisher` may act on `owned` when it can
 * act on *any* row (`anyCap`) or when it owns the row and can act on
 * *own* rows (`ownCap`). `ownerId` is the row's owner column
 * (`publisher_id` / `author_id` / `owner_id`); a null owner is treated
 * as not-owned (the caller must hold the `.any` capability).
 */
export function canOwnOrAny(
  publisher: PublisherRow,
  ownerId: string | null | undefined,
  ownCap: Capability,
  anyCap: Capability,
): boolean {
  if (can(publisher, anyCap)) return true
  return ownerId != null && ownerId === publisher.id && can(publisher, ownCap)
}
