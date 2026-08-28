// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Auth middleware for /api/v1/publish/**.
 *
 * Wraps every publisher-API route. Three jobs:
 *
 *   1. Verify the caller's identity. In production that means a
 *      Cloudflare Access JWT delivered via `Cf-Access-Jwt-Assertion`
 *      (browser cookie or service-token client). In dev — when
 *      `DEV_BYPASS_ACCESS=true` — synthesise an identity keyed off
 *      `DEV_PUBLISHER_EMAIL` (default `dev@localhost`) so the
 *      contributor walkthrough doesn't require a configured Access
 *      tunnel.
 *   2. JIT-provision a `publishers` row keyed off the caller's
 *      email, with role/status defaults appropriate to the origin
 *      (see `publisher-store.ts`).
 *   3. Attach the resolved publisher row to `context.data.publisher`
 *      so downstream handlers can authorise without re-running the
 *      lookup.
 *   4. Enforce the per-node feature toggles centrally: a route whose
 *      path prefix maps to a disabled feature (see
 *      {@link featureForPath}) gets a 403 `feature_disabled` without
 *      touching the handler. Handlers own *role* authorisation;
 *      the middleware owns *feature* availability.
 *
 * Failure modes (typed envelopes, same shape as the rest of the API):
 *   - 503 `binding_missing` — CATALOG_DB not bound.
 *   - 503 `access_unconfigured` — neither Access env vars nor
 *     `DEV_BYPASS_ACCESS=true` are set; the middleware fails closed
 *     so a misconfigured deploy can't accidentally serve un-auth'd.
 *   - 401 `unauthenticated` — assertion missing or invalid.
 *   - 403 `pending` — publisher row exists but is `status='pending'`
 *     (Phase 1a has no admin UI; an operator flips this manually).
 *   - 403 `suspended` — publisher row is `status='suspended'`.
 *   - 403 `feature_disabled` — the route belongs to a feature the
 *     node operator turned off (`{ error, feature, message }` so the
 *     portal can render the right card; 403 not 404 so "disabled by
 *     operator" is distinguishable from "no such route").
 *   - 500 `dev_bypass_unsafe` — `DEV_BYPASS_ACCESS=true` against a
 *     non-loopback hostname. Defense in depth even though the env
 *     var should never be set in production.
 */

import type { FeatureKey } from '../../../../src/types/node-features'
import { CatalogEnv } from '../_lib/env'
import { accessConfig, verifyAccessJwt, type AccessIdentity } from '../_lib/access-auth'
import { isLoopbackHost } from '../_lib/loopback'
import { getEffectiveFeatures } from '../_lib/node-settings-store'
import {
  getOrCreatePublisher,
  parseTrustedDomains,
  type PublisherRow,
} from '../_lib/publisher-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

export interface PublisherData {
  publisher: PublisherRow
}

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

/**
 * Path-prefix → feature map for the central gate. Matching is
 * segment-boundary (`path === prefix || path.startsWith(prefix + '/')`)
 * — critical so `/publish/featured` (datasets) does not swallow
 * `/publish/featured-hero` (hero).
 *
 * Deliberately NOT in the table (never feature-gated): `me`,
 * `node-profile` (+logo), `node-settings`, `node-identity`,
 * `publishers`, `redirect-back`, and `analytics-export` (the nightly
 * rollup keeps archiving while the dashboard is hidden, so
 * re-enabling analytics leaves no data gap).
 */
export const FEATURE_GATED_PREFIXES: ReadonlyArray<readonly [string, FeatureKey]> = [
  ['/api/v1/publish/events', 'events'],
  ['/api/v1/publish/feeds', 'events'],
  // Media suggestions (youtube-search/channels, nhc-storms) exist to
  // illustrate events in the review queue — they ride the events key.
  ['/api/v1/publish/media', 'events'],
  ['/api/v1/publish/blog', 'blog'],
  ['/api/v1/publish/featured-hero', 'hero'],
  ['/api/v1/publish/tours', 'tours'],
  ['/api/v1/publish/workflows', 'workflows'],
  ['/api/v1/publish/analytics', 'analytics'],
  ['/api/v1/publish/datasets', 'datasets'],
  ['/api/v1/publish/featured', 'datasets'],
  ['/api/v1/publish/feedback', 'feedback'],
]

/**
 * Exact paths exempt from the gate even though a prefix matches.
 * Both are cron-invoked (GitHub Actions): a middleware 403 would
 * turn the cron red every run, so each handler no-ops with a 200
 * itself when its feature is off.
 */
export const FEATURE_GATE_EXEMPT_PATHS: ReadonlySet<string> = new Set([
  '/api/v1/publish/events/refresh',
  '/api/v1/publish/workflows/due',
])

/** The feature a request path belongs to, or null when ungated. */
export function featureForPath(pathname: string): FeatureKey | null {
  if (FEATURE_GATE_EXEMPT_PATHS.has(pathname)) return null
  for (const [prefix, feature] of FEATURE_GATED_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) return feature
  }
  return null
}

/**
 * Wrap the chained handler (`context.next()`) in a try / catch so
 * an unhandled exception in any /api/v1/publish/** route surfaces
 * as a structured JSON 500 rather than Cloudflare's generic 1101
 * "worker_threw_exception" page (which swallows the error
 * detail). Only the access-gated publisher API is wrapped, so the
 * structured detail is only visible to authenticated staff
 * publishers.
 *
 * The response includes a *sanitized* first line of the
 * exception's `.message` — enough to surface
 * `"D1_ERROR: table datasets has no column named bbox_n"` so the
 * publisher can recognise a missing-migration deploy without
 * reading server logs, but stripped of stack-frame fragments
 * (`at Foo (file://…)` lines, `file://…:42:13` location refs)
 * that CodeQL's `js/stack-trace-exposure` rule flags. Operators
 * who need the full stack read it from Cloudflare Workers logs
 * via `wrangler tail` — the raw error is logged via
 * `console.error` below before sanitization runs.
 */

/** Strip stack-frame fragments from a thrown-Error message so the
 *  wire-safe payload is the structured detail (D1 codes, SQLite
 *  errors, validation messages) without `at …:LINE:COL` traces.
 *  Keeps the first line of the message, then drops anything that
 *  looks like a JS stack frame ("at Foo (…)", "Error: …" on a
 *  later line) or a file:line:col location. */
function sanitizeErrorMessage(raw: string): string {
  // Take only the first line; stacks always start on line 2+.
  const firstLine = raw.split('\n', 1)[0] ?? ''
  // Drop anything that looks like a file/URL location reference.
  // Conservative — false positives just produce a shorter
  // message, which is acceptable.
  return firstLine
    .replace(/\s*\bat\s+[^\s)]+\s*\([^)]*\)/g, '')
    .replace(/\s*[A-Za-z0-9_./:\\-]+:\d+:\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

async function nextOrCaught(context: Parameters<PagesFunction<CatalogEnv>>[0]): Promise<Response> {
  try {
    return await context.next()
  } catch (err) {
    // Log the raw error (with full stack) to Workers logs FIRST so
    // an operator can recover it via `wrangler tail` regardless of
    // what the sanitizer does to the wire response.
    console.error('[publish-middleware] unhandled exception', err)
    const raw = err instanceof Error ? err.message : String(err)
    const message = sanitizeErrorMessage(raw)
    return new Response(
      JSON.stringify({ error: 'unhandled_exception', message }),
      { status: 500, headers: { 'Content-Type': CONTENT_TYPE } },
    )
  }
}

export const onRequest: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(
      503,
      'binding_missing',
      'CATALOG_DB binding is not configured on this deployment.',
    )
  }

  const devBypass = context.env.DEV_BYPASS_ACCESS === 'true'
  // Via `accessConfig` so a whitespace-only value counts as unset:
  // otherwise the deploy looks configured here and then fails every
  // assertion inside the verifier, which is a much worse error to
  // debug than a 503 naming the two variables.
  const { teamDomain, aud } = accessConfig(context.env)
  const accessConfigured = !!(teamDomain && aud)

  if (!devBypass && !accessConfigured) {
    return jsonError(
      503,
      'access_unconfigured',
      'Cloudflare Access is not configured. Set ACCESS_TEAM_DOMAIN + ' +
        'ACCESS_AUD, or set DEV_BYPASS_ACCESS=true for local development.',
    )
  }

  let identity: AccessIdentity | null = null

  if (devBypass) {
    const url = new URL(context.request.url)
    if (!isLoopbackHost(url.hostname)) {
      return jsonError(
        500,
        'dev_bypass_unsafe',
        `DEV_BYPASS_ACCESS=true refuses to honor a non-loopback hostname (got "${url.hostname}").`,
      )
    }
    identity = {
      email: context.env.DEV_PUBLISHER_EMAIL ?? 'dev@localhost',
      sub: 'dev-local',
      type: 'user',
    }
  } else {
    const token = context.request.headers.get('Cf-Access-Jwt-Assertion')?.trim()
    if (!token) {
      return jsonError(401, 'unauthenticated', 'Missing Cf-Access-Jwt-Assertion header.')
    }
    identity = await verifyAccessJwt(token, context.env)
    if (!identity) {
      return jsonError(401, 'unauthenticated', 'Invalid or expired Access assertion.')
    }
  }

  const trustedDomains = parseTrustedDomains(context.env.TRUSTED_PUBLISHER_DOMAINS)
  const publisher = await getOrCreatePublisher(context.env.CATALOG_DB, identity, {
    devBypass,
    trustedDomains,
  })

  if (publisher.status === 'suspended') {
    return jsonError(403, 'suspended', 'This publisher account is suspended.')
  }
  if (publisher.status === 'pending') {
    return jsonError(
      403,
      'pending',
      'This publisher account is awaiting approval. Contact an operator.',
    )
  }

  // Feature gate — after identity (the toggle set is not public
  // knowledge for unauthenticated callers on this surface), before
  // the handler. `getEffectiveFeatures` is fail-open: a KV/D1 blip
  // serves the route rather than erroring.
  const gatedFeature = featureForPath(new URL(context.request.url).pathname)
  if (gatedFeature) {
    const features = await getEffectiveFeatures(context.env)
    if (!features[gatedFeature]) {
      return new Response(
        JSON.stringify({
          error: 'feature_disabled',
          feature: gatedFeature,
          message: `The ${gatedFeature} feature is disabled on this node.`,
        }),
        { status: 403, headers: { 'Content-Type': CONTENT_TYPE } },
      )
    }
  }

  // Stash the row so route handlers can authorise without re-querying D1.
  ;(context.data as unknown as PublisherData).publisher = publisher
  return nextOrCaught(context)
}
