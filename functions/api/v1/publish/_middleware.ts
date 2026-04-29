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
 *   - 500 `dev_bypass_unsafe` — `DEV_BYPASS_ACCESS=true` against a
 *     non-loopback hostname. Defense in depth even though the env
 *     var should never be set in production.
 */

import { CatalogEnv } from '../_lib/env'
import { verifyAccessJwt, type AccessIdentity } from '../_lib/access-auth'
import {
  getOrCreatePublisher,
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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost')
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
  const accessConfigured = !!(context.env.ACCESS_TEAM_DOMAIN && context.env.ACCESS_AUD)

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
    if (!isLoopback(url.hostname)) {
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
    const token = context.request.headers.get('Cf-Access-Jwt-Assertion')
    if (!token) {
      return jsonError(401, 'unauthenticated', 'Missing Cf-Access-Jwt-Assertion header.')
    }
    identity = await verifyAccessJwt(token, context.env)
    if (!identity) {
      return jsonError(401, 'unauthenticated', 'Invalid or expired Access assertion.')
    }
  }

  const publisher = await getOrCreatePublisher(context.env.CATALOG_DB, identity, {
    devBypass,
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

  // Stash the row so route handlers can authorise without re-querying D1.
  ;(context.data as unknown as PublisherData).publisher = publisher
  return context.next()
}
