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
 *   | Node has | Access token accepted when |
 *   |---|---|
 *   | `ACCESS_TEAM_DOMAIN` and `ACCESS_FEEDBACK_AUD` | signed by the team, for `ACCESS_FEEDBACK_AUD`'s application |
 *   | `ACCESS_TEAM_DOMAIN` only | signed by the team, for any of its applications; one other than `ACCESS_AUD`'s is logged with its AUD |
 *   | no `ACCESS_TEAM_DOMAIN` | never: nothing to check a token against |
 *
 * The second row takes application tokens only (`type: 'app'`), not
 * the team-wide session token, which no application's policy gates.
 * A later release drops it.
 *
 * The third row refuses the header's mere presence, which the routes
 * used to accept. A node built by the guide without Access has no
 * Access application in front of these paths, so on it every such
 * header is forged. The `FEEDBACK_ADMIN_TOKEN` bearer is its way in.
 *
 * Once `ACCESS_FEEDBACK_AUD` is set, `ACCESS_AUD` alone no longer
 * counts. A publisher-application token is held by everyone that
 * application's policy admits, including publishers the portal has
 * suspended, so it is not a feedback credential unless the operator
 * says so by setting `ACCESS_FEEDBACK_AUD` to the same value.
 */

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
 * - `verified`: signed by the team, for the application this node names.
 * - `team-only`: signed by the team, for another of its applications,
 *   while `ACCESS_FEEDBACK_AUD` is unset (transitional).
 * - `refused`: a header that fails the check.
 * - `unverifiable`: a header on a node with no `ACCESS_TEAM_DOMAIN`.
 * - `absent`: no Access header.
 */
export type FeedbackAccessVerdict = 'verified' | 'team-only' | 'refused' | 'unverifiable' | 'absent'

/** Whether a verdict lets the request in without the bearer. */
const ADMITS = {
  verified: true,
  'team-only': true,
  refused: false,
  unverifiable: false,
  absent: false,
} satisfies Record<FeedbackAccessVerdict, boolean>

const ACCESS_HEADERS = ['cf-access-jwt-assertion', 'cf-access-authenticated-user-email'] as const

interface Options {
  fetchImpl?: typeof fetch
  now?: number
  warn?: (message: string) => void
}

interface Verdict {
  verdict: FeedbackAccessVerdict
  /** A line for the operator, with no token, email or address in it. */
  warning?: string
}

async function judge(request: Request, env: FeedbackAdminEnv, options: Options): Promise<Verdict> {
  const { teamDomain, aud } = accessConfig(env)
  const feedbackAud = env.ACCESS_FEEDBACK_AUD?.trim() || undefined
  const token = request.headers.get('cf-access-jwt-assertion')?.trim()

  if (!teamDomain) {
    if (!ACCESS_HEADERS.some(h => request.headers.get(h)?.trim())) return { verdict: 'absent' }
    return {
      verdict: 'unverifiable',
      warning:
        'feedback admin: refused an Access header because ACCESS_TEAM_DOMAIN is unset, so no token can be checked. Set ACCESS_TEAM_DOMAIN to use Access on these routes, or use FEEDBACK_ADMIN_TOKEN.',
    }
  }
  if (!token) return { verdict: 'absent' }

  const verified = await verifyAccessJwtAnyAudience(token, env, options)
  if (!verified) return { verdict: 'refused' }
  if (feedbackAud) return { verdict: verified.audiences.includes(feedbackAud) ? 'verified' : 'refused' }
  if (aud && verified.audiences.includes(aud)) return { verdict: 'verified' }
  if (verified.tokenType !== 'app') return { verdict: 'refused' }
  return {
    verdict: 'team-only',
    // An AUD tag is neither personal nor secret, and it is the value
    // the operator may want for ACCESS_FEEDBACK_AUD.
    warning:
      `feedback admin: accepted an Access token for an application this node does not name (audience ${verified.audiences.join(', ') || 'none'}). ` +
      'Set ACCESS_FEEDBACK_AUD to the AUD of the Access application covering these paths (docs/SELF_HOSTING.md §6.4).',
  }
}

export async function feedbackAccessVerdict(
  request: Request,
  env: FeedbackAdminEnv,
  options: Options = {},
): Promise<FeedbackAccessVerdict> {
  return (await judge(request, env, options)).verdict
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
  const { verdict, warning } = await judge(request, env, options)
  if (warning) (options.warn ?? ((m: string) => console.warn(m)))(warning)
  return ADMITS[verdict] || bearerMatches(request, env.FEEDBACK_ADMIN_TOKEN)
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
