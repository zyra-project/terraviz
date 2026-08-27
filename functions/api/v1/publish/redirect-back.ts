// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * GET /api/v1/publish/redirect-back?to=<path>
 *
 * Sets the API app's Access cookie and bounces the browser to a
 * portal path. Solves the two-Access-app cookie-scope problem that
 * 3pa/C-fix could only diagnose, not fix:
 *
 * Cloudflare Access scopes each application's `CF_Authorization`
 * cookie to the application's URL paths. When the publisher portal
 * and the publisher API are gated by two different Access
 * applications (because the 5-destination-per-app limit forces a
 * split — see `SELF_HOSTING.md` Phase 6.2), a user who has signed into
 * the portal app via SSO holds a cookie scoped to `/publish/` but
 * none scoped to `/api/v1/publish/`. A `fetch()` from the portal
 * to the API path doesn't carry any cookie that satisfies the API
 * app's audience, so Access redirects to its cross-origin login
 * page — which CORS blocks at the fetch boundary regardless of
 * `redirect: 'follow' | 'manual'`.
 *
 * This endpoint is gated by the same Access middleware as every
 * other `/api/v1/publish/**` route. When the browser navigates to
 * it top-level (not via fetch), Cloudflare Access transparently
 * authenticates via the team-level session, sets the API app's
 * cookie at `Path=/api/v1/publish/`, then forwards the request.
 * The handler then 302s back to the portal path, where the now-
 * present API cookie satisfies subsequent fetches.
 *
 * Safety: `to` must be a path on this host beginning with
 * `/publish` (the portal mount point). Open redirects to arbitrary
 * URLs are rejected — that would be a phishing aid masquerading
 * as a Cloudflare Access flow.
 */

import type { CatalogEnv } from '../_lib/env'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

/**
 * Validate that `to` is a same-host, /publish-prefixed path. The
 * URL `Location` header is interpreted by the browser as an
 * absolute URL if it includes a scheme or as a relative URL if it
 * doesn't. We deliberately accept only relative paths to a fixed
 * prefix so a malicious `?to=https://evil.example` cannot
 * weaponize this endpoint.
 */
export function isSafeRedirectTarget(to: string | null): to is string {
  if (!to) return false
  if (to.length > 1024) return false
  // Reject anything that looks like a scheme or protocol-relative URL.
  if (!to.startsWith('/')) return false
  if (to.startsWith('//')) return false
  // Reject control characters and CRLF (Location-header injection).
  if (/[\x00-\x1f\x7f]/.test(to)) return false
  // Parse against a dummy origin so we can validate `pathname`
  // independent of any query / hash the portal's sign-in URL
  // builder appended (e.g. `?utm=…`). A relative path that
  // smuggles a host override would resolve away from the dummy
  // origin; the host check below catches that.
  let parsed: URL
  try {
    parsed = new URL(to, 'http://safe-check.invalid')
  } catch {
    return false
  }
  if (parsed.host !== 'safe-check.invalid') return false
  if (parsed.pathname !== '/publish' && !parsed.pathname.startsWith('/publish/')) {
    return false
  }
  return true
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  const url = new URL(context.request.url)
  const to = url.searchParams.get('to')
  if (!isSafeRedirectTarget(to)) {
    return jsonError(
      400,
      'invalid_redirect_target',
      'the `to` query parameter must be a path beginning with /publish',
    )
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: to,
      // No caching — the redirect is a one-shot used to set a
      // cookie, not a piece of static content.
      'Cache-Control': 'no-store',
    },
  })
}
