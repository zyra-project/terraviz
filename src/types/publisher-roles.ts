/**
 * Publisher roles & capabilities — the single source of truth for the
 * portal's authorization model, shared by the Cloudflare Pages
 * Functions backend (`functions/`) and the SPA portal
 * (`src/ui/publisher/`). Mirrors the shape of `node-features.ts`: a
 * pure, dependency-free constant both tiers import so the policy lives
 * in exactly one table.
 *
 * Design: `docs/PUBLISHER_ROLES_PLAN.md`.
 *
 * A **capability** is a verb the server checks, independent of role.
 * A **role** maps to a set of capabilities. Gates ask
 * `roleCan(role, cap)` (server: `can(publisher, cap)`), never
 * `role === '...'`.
 *
 * Phase R1 is behavior-preserving: the matrix below reproduces today's
 * effective behavior for the current role strings — in particular
 * `reviewer` (today's `readonly`) still carries the authoring
 * capabilities it has always had in practice, because `readonly` was
 * never enforced. Phase R2 tightens it to a true read-only role. Until
 * the `0039` rename migration lands, the legacy `publisher` / `readonly`
 * strings are accepted as aliases of `author` / `reviewer`.
 */

/** The capability vocabulary (see the plan doc §3). */
export const CAPABILITIES = [
  'content.read',
  'content.create',
  'content.edit.own',
  'content.delete.own',
  'content.publish.own',
  'content.edit.any',
  'content.delete.any',
  'content.publish.any',
  'insights.read',
  'hero.read',
  'hero.manage',
  'operator.manage',
  'users.manage',
] as const

export type Capability = (typeof CAPABILITIES)[number]

/**
 * Canonical role identifiers. `author` / `reviewer` are the post-`0039`
 * names for the legacy `publisher` / `readonly` strings; both are
 * accepted on the wire (see {@link normalizeRole}). `service` is the
 * non-assignable machine role (capability-equivalent to `admin`).
 */
export const ROLES = ['admin', 'editor', 'author', 'contributor', 'reviewer', 'service'] as const
export type Role = (typeof ROLES)[number]

/** Roles an admin may assign through the Users tab (excludes the
 *  machine-only `service`). Ordered most- to least-privileged. */
export const ASSIGNABLE_ROLES: readonly Role[] = ['admin', 'editor', 'author', 'contributor', 'reviewer']

const ALL: ReadonlySet<Capability> = new Set(CAPABILITIES)

// The machine role is capability-equivalent to admin for content +
// operator work, but must NOT manage users — a leaked service token
// must not be able to promote/suspend publishers. This mirrors today's
// `isAdmin` (strictly `role === 'admin'`, excluding `service`).
const SERVICE_CAPS: ReadonlySet<Capability> = new Set(
  CAPABILITIES.filter(c => c !== 'users.manage'),
)

// --- The matrix. Each role → the capabilities it holds. ------------------
//
// R1 note: `reviewer` intentionally mirrors `author` here to preserve
// today's (unenforced-`readonly`) behavior. R2 replaces the reviewer row
// with `READ_ONLY`.
const AUTHOR_CAPS: ReadonlySet<Capability> = new Set<Capability>([
  'content.read',
  'content.create',
  'content.edit.own',
  'content.delete.own',
  'content.publish.own',
  'insights.read',
  'hero.read',
])

const CONTRIBUTOR_CAPS: ReadonlySet<Capability> = new Set<Capability>([
  'content.read',
  'content.create',
  'content.edit.own',
  'content.delete.own',
  'insights.read',
  'hero.read',
])

const EDITOR_CAPS: ReadonlySet<Capability> = new Set<Capability>([
  ...AUTHOR_CAPS,
  'content.edit.any',
  'content.delete.any',
  'content.publish.any',
  'hero.manage',
])

// R1: reviewer == author (behavior-preserving). R2 flips this to a true
// read-only set (`content.read` + `insights.read` + `hero.read`).
const REVIEWER_CAPS_R1: ReadonlySet<Capability> = AUTHOR_CAPS

export const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  admin: ALL,
  service: SERVICE_CAPS,
  editor: EDITOR_CAPS,
  author: AUTHOR_CAPS,
  contributor: CONTRIBUTOR_CAPS,
  reviewer: REVIEWER_CAPS_R1,
}

/**
 * Fold a stored role string (which may still be a legacy
 * `publisher` / `readonly` value pre-`0039`, or an unknown string) into
 * a canonical {@link Role}. Unknown roles fall to the least-privileged
 * `reviewer` — fail-closed, the opposite of the feature-toggle
 * fail-open, because this gates writes.
 */
export function normalizeRole(role: string | null | undefined): Role {
  switch (role) {
    case 'admin':
    case 'editor':
    case 'author':
    case 'contributor':
    case 'reviewer':
    case 'service':
      return role
    case 'publisher':
      return 'author'
    case 'readonly':
      return 'reviewer'
    default:
      return 'reviewer'
  }
}

/** Whether `role` (canonical or legacy string) holds `cap`. */
export function roleCan(role: string | null | undefined, cap: Capability): boolean {
  return ROLE_CAPABILITIES[normalizeRole(role)].has(cap)
}

/** The full capability list a role holds — for `GET /publish/me` and
 *  the portal's `can()` helper. */
export function capabilitiesForRole(role: string | null | undefined): Capability[] {
  return CAPABILITIES.filter(c => ROLE_CAPABILITIES[normalizeRole(role)].has(c))
}
