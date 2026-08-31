// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * GET /api/v1/logout
 *
 * Clears the user's Cloudflare Access session by redirecting to
 * the team-level logout endpoint, then bounces the browser back
 * to the public app root. Public — NOT gated by the publisher
 * middleware. Logout has to work even from an expired session
 * (the user clicks "Sign out" precisely because their state is
 * uncertain), so we keep this outside `/api/v1/publish/**`.
 *
 * Cloudflare's logout endpoint clears the team-level session
 * cookie at `.cloudflareaccess.com`. Per-app `CF_Authorization`
 * cookies on the protected hostname may persist until their own
 * expiry (24h default), but without the team session they can't
 * be refreshed and the next gated request triggers fresh SSO.
 *
 * Behaviour:
 *   - ACCESS_TEAM_DOMAIN set → 302 to
 *     `https://<team>/cdn-cgi/access/logout?returnTo=<base>/`.
 *   - ACCESS_TEAM_DOMAIN unset (dev / local-only deploys) → 302
 *     to `/` directly. There's no Access session to clear, so
 *     the right behaviour is just to navigate away.
 *
 * `returnTo` is computed from the request's own origin so a fork
 * deployed at a different hostname doesn't need extra config.
 */

import type { CatalogEnv } from './_lib/env'

function buildReturnTo(req: Request): string {
  const url = new URL(req.url)
  return `${url.origin}/`
}

function safeTeamDomain(raw: string | undefined): string | null {
  if (!raw) return null
  // Strip any accidental protocol prefix and trailing slashes —
  // the operator sets this in the dashboard as a bare hostname,
  // but be defensive.
  // Leading/trailing whitespace is stripped first: without it, a
  // team domain that picked up a newline in the dashboard fails
  // the hostname check below and logout silently bounces to `/`
  // instead of ending the Access session. Interior whitespace is
  // still rejected — that isn't a hostname.
  const trimmed = raw.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  // Cloudflare Access team domains are `<team>.cloudflareaccess.com`
  // by default; we accept any hostname-shaped value to keep the
  // door open for custom domains operators may set up. Reject
  // anything with whitespace or path separators that could escape
  // into the Location header.
  if (!/^[a-z0-9.-]+$/i.test(trimmed)) return null
  return trimmed
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  const returnTo = buildReturnTo(context.request)
  const team = safeTeamDomain(context.env.ACCESS_TEAM_DOMAIN)

  if (!team) {
    // No Access configured — there's nothing to log out of.
    // Bounce to the app root so the button still behaves sensibly.
    return new Response(null, {
      status: 302,
      headers: { Location: '/', 'Cache-Control': 'no-store' },
    })
  }

  const target = `https://${team}/cdn-cgi/access/logout?returnTo=${encodeURIComponent(returnTo)}`
  return new Response(null, {
    status: 302,
    headers: { Location: target, 'Cache-Control': 'no-store' },
  })
}

// Exported for the test.
export { buildReturnTo, safeTeamDomain }
