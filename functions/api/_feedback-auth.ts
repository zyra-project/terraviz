// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Who may read the feedback admin routes: the six `?action=` and
 * legacy endpoints listed in `_feedback-helpers.ts`. Non-route
 * module (the leading underscore keeps Pages from routing it).
 *
 * Two ways in, tried in this order:
 *
 *   1. **A Cloudflare Access token** in `Cf-Access-Jwt-Assertion`.
 *      Access adds it to a request on a path one of its applications
 *      covers.
 *   2. **The `FEEDBACK_ADMIN_TOKEN` bearer**, for nodes without
 *      Access and for scripts. Unchanged.
 *
 * The routes used to accept the Access header's mere *presence*
 * (`isInternalRequest` in `ingest.ts`, which only tags telemetry).
 * A client can send that header itself, so on a path no Access
 * application covers, `Cf-Access-Jwt-Assertion: x` read every
 * feedback report. `npm run setup` builds one application, covering
 * only the publisher paths, so a node built that way had all six
 * routes outside Access unless its operator added the optional
 * application in `docs/SELF_HOSTING.md` §6.4.
 *
 * **Transitional.** Verifying the token closes that hole on any node
 * with `ACCESS_TEAM_DOMAIN`. Checking its audience as well would
 * break nodes that run §6.4's application, whose tokens carry that
 * application's AUD, and have no variable naming it. So:
 *
 *   | Node has | Token accepted when |
 *   |---|---|
 *   | `ACCESS_FEEDBACK_AUD` and `ACCESS_TEAM_DOMAIN` | signed by the team, audience is `ACCESS_FEEDBACK_AUD` or `ACCESS_AUD` |
 *   | `ACCESS_TEAM_DOMAIN` only | signed by the team, any audience; a token for an application other than `ACCESS_AUD`'s is logged |
 *   | neither | header present, as before, logged |
 *   | `ACCESS_FEEDBACK_AUD` without `ACCESS_TEAM_DOMAIN` | never: the operator asked for a check this node cannot make |
 *
 * `ACCESS_AUD` is accepted beside the feedback AUD because a node
 * may cover these paths with its publisher application instead.
 * A later release drops the second and third rows.
 */

import { isInternalRequest } from './ingest'
import { accessConfig, verifyAccessJwtAnyAudience } from './v1/_lib/access-auth'

export interface FeedbackAdminEnv {
  FEEDBACK_DB?: D1Database
  FEEDBACK_ADMIN_TOKEN?: string
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  /**
   * AUD of the Access application covering the feedback admin paths
   * (`docs/SELF_HOSTING.md` §6.4). Set it to `ACCESS_AUD`'s value if
   * the publisher application covers them.
   */
  ACCESS_FEEDBACK_AUD?: string
  /** JWKS cache, shared with the publisher API. */
  CATALOG_KV?: KVNamespace
}

/**
 * What the Access header proves, before the bearer is consulted.
 *
 * - `verified`: signed by the team, for an application this node names.
 * - `team-only`: signed by the team, audience unchecked (transitional).
 * - `unverified`: no team domain to check against; header present.
 * - `refused`: a header that fails the check.
 * - `misconfigured`: a header, and `ACCESS_FEEDBACK_AUD` without the
 *   `ACCESS_TEAM_DOMAIN` needed to check it. Refused.
 * - `absent`: no Access header.
 */
export type FeedbackAccessVerdict =
  | 'verified'
  | 'team-only'
  | 'unverified'
  | 'refused'
  | 'misconfigured'
  | 'absent'

interface Options {
  fetchImpl?: typeof fetch
  now?: number
  warn?: (message: string) => void
}

export async function feedbackAccessVerdict(
  request: Request,
  env: FeedbackAdminEnv,
  options: Options = {},
): Promise<FeedbackAccessVerdict> {
  const { teamDomain, aud } = accessConfig(env)
  const feedbackAud = env.ACCESS_FEEDBACK_AUD?.trim() || undefined
  const token = request.headers.get('cf-access-jwt-assertion')?.trim()

  if (!teamDomain) {
    if (!isInternalRequest(request)) return 'absent'
    return feedbackAud ? 'misconfigured' : 'unverified'
  }
  if (!token) return 'absent'

  const verified = await verifyAccessJwtAnyAudience(token, env, options)
  if (!verified) return 'refused'
  const named = [feedbackAud, aud].filter((a): a is string => !!a)
  if (verified.audiences.some(a => named.includes(a))) return 'verified'
  return feedbackAud ? 'refused' : 'team-only'
}

const WARNINGS: Partial<Record<FeedbackAccessVerdict, string>> = {
  'team-only':
    'feedback admin: accepted an Access token without checking its audience. Set ACCESS_FEEDBACK_AUD to the AUD of the Access application covering these paths (docs/SELF_HOSTING.md §6.4).',
  unverified:
    'feedback admin: accepted an unverified Access header because ACCESS_TEAM_DOMAIN is unset. A later release will refuse it; set ACCESS_TEAM_DOMAIN and ACCESS_FEEDBACK_AUD, or use FEEDBACK_ADMIN_TOKEN.',
  misconfigured:
    'feedback admin: refused an Access header because ACCESS_FEEDBACK_AUD is set and ACCESS_TEAM_DOMAIN is not, so no token can be checked. Set ACCESS_TEAM_DOMAIN.',
}

/**
 * True when the request may read feedback: an Access token this
 * node accepts, or the bearer. A refused Access header falls through
 * to the bearer, so a script sending both still gets in.
 */
export async function authenticateFeedbackAdmin(
  request: Request,
  env: FeedbackAdminEnv,
  options: Options = {},
): Promise<boolean> {
  const verdict = await feedbackAccessVerdict(request, env, options)
  const warning = WARNINGS[verdict]
  if (warning) (options.warn ?? ((m: string) => console.warn(m)))(warning)
  if (verdict === 'verified' || verdict === 'team-only' || verdict === 'unverified') return true
  return bearerMatches(request, env.FEEDBACK_ADMIN_TOKEN)
}

/**
 * Both sides trimmed. A FEEDBACK_ADMIN_TOKEN stored with a trailing
 * newline can never match a correctly-sent header, and the failure
 * is a flat 401 with nothing to distinguish it from a wrong token.
 * A whitespace-only secret counts as unset.
 */
function bearerMatches(request: Request, token?: string): boolean {
  const expected = token?.trim()
  if (!expected) return false
  const auth = request.headers.get('Authorization')
  if (!auth) return false
  const bearer = auth.replace(/^Bearer\s+/i, '').trim()
  return bearer === expected
}
