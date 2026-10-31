// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * GET /api/v1/federation/feed — the signed public federation feed
 * (metadata Phase 5, step 2). Off unless `FEDERATION_ENABLED` is
 * `'true'`; off, the path answers 404 as though it did not exist. On
 * but without a usable `FEDERATION_ABUSE_CONTACT`, it answers 503: the
 * protocol does not let a node federate without one
 * (`_lib/federation-config.ts`).
 *
 * Query: `since` (a cursor from a previous page; absent is a full sync
 * from the start) and `limit` (1–250, default 100). Any other
 * parameter, or either one repeated, is a 400: the request target is
 * part of what is signed, so the feed accepts exactly one spelling of
 * each request rather than signing pages for targets it ignored.
 *
 * Every 200 is signed (`federation-signature.ts`): the body is the
 * page's canonical JSON, and `Terraviz-Signature` covers it with the
 * node's `node_id`, the signing time and this request's path and
 * query. A node whose signing secret is missing, unreadable or not the
 * pair of `node_identity.public_key` answers 503 rather than serve
 * pages every peer must reject.
 *
 * This route reads storage only through `FederationFeedStore` and never
 * prepares a statement itself (federation-scoping.md §7 Directive 1).
 * Page semantics — what is a tombstone, the settle watermark, what a
 * subscriber does with a full sync — are in `_lib/federation-feed.ts`.
 */

import type { CatalogEnv } from '../_lib/env'
import { IDENTITY_MISSING_MESSAGE } from '../_lib/catalog-store'
import { serializeDataset } from '../_lib/dataset-serializer'
import { makeDataRefResolver } from '../_lib/data-ref-resolver'
import { buildFramesRedirectTemplate, resolveAssetRefStrict } from '../_lib/r2-public-url'
import {
  buildFeedPage,
  decodeFeedCursor,
  parseFeedLimit,
  type FeedPosition,
  type FeedSerializer,
} from '../_lib/federation-feed'
import { d1FederationFeedStore } from '../_lib/federation-feed-d1'
import { federationState, loadSigningKey, resetFeedSigningKeyCache as resetSigningKey } from '../_lib/federation-config'
import {
  CanonicalJsonError,
  canonicalJson,
  signFederationBody,
  SIGNATURE_HEADER,
} from '../_lib/federation-signature'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const ALLOWED_PARAMS = new Set(['since', 'limit'])
const requestRates = new Map<string, { count: number; until: number }>()

export function resetFeedSigningKeyCache(): void {
  resetSigningKey()
  requestRates.clear()
}

/** The rate-limit key for a caller: an IPv6 address by its /64 (any
 *  spelling of it), an IPv4-mapped one as its IPv4 address, and an IPv4
 *  address as it is. */
export function feedRateKey(address: string): string {
  if (!address.includes(':')) return address
  try {
    const host = new URL(`http://[${address}]/`).hostname.slice(1, -1)
    const [left, right = ''] = host.split('::')
    const prefix = left ? left.split(':') : []
    const suffix = right ? right.split(':') : []
    const groups = host.includes('::') ? [...prefix, ...Array(8 - prefix.length - suffix.length).fill('0'), ...suffix] : prefix
    if (groups.length !== 8) return 'unknown'
    const words = groups.map(group => parseInt(group, 16))
    // An IPv4-mapped address (`::ffff:a.b.c.d`) is one IPv4 client, and
    // its /64 is the same for every one of them, so key it as IPv4.
    if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
      return [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff].join('.')
    }
    return words.slice(0, 4).map(word => word.toString(16)).join(':') + '::/64'
  } catch { return 'unknown' }
}

function rateLimited(request: Request): boolean {
  const now = Date.now()
  const address = feedRateKey(request.headers.get('CF-Connecting-IP') ?? 'unknown')
  let entry = requestRates.get(address)
  if (!entry || now >= entry.until) {
    if (entry) requestRates.delete(address)
    for (const [key, value] of requestRates) {
      if (now < value.until) break
      requestRates.delete(key)
    }
    if (requestRates.size >= 10_000) requestRates.delete(requestRates.keys().next().value!)
    entry = { count: 0, until: now + 60_000 }
    requestRates.set(address, entry)
  }
  return ++entry.count > 600
}

/** Replace lone surrogates in every string with U+FFFD, so a row whose
 *  text was stored malformed still has a canonical form to sign. */
export function wellFormed<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD') as T
  if (Array.isArray(value)) return value.map(wellFormed) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, member]) => [wellFormed(key), wellFormed(member)])) as T
  }
  return value
}

function errorResponse(status: number, error: string, message?: string): Response {
  return new Response(JSON.stringify(message ? { error, message } : { error }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'no-store' },
  })
}

const serveFeed: PagesFunction<CatalogEnv> = async context => {
  const env = context.env
  const federation = federationState(env)
  if (federation.state === 'off') return errorResponse(404, 'not_found')
  if (federation.state === 'no_abuse_contact') {
    return errorResponse(
      503,
      'abuse_contact_missing',
      'Federation needs an abuse contact: set FEDERATION_ABUSE_CONTACT to an email address.',
    )
  }
  if (!['GET', 'HEAD'].includes(context.request.method)) {
    const response = errorResponse(405, 'method_not_allowed')
    response.headers.set('Allow', 'GET, HEAD')
    return response
  }
  if (rateLimited(context.request)) {
    const response = errorResponse(429, 'rate_limited')
    response.headers.set('Retry-After', '60')
    return response
  }
  if (!env.CATALOG_DB) {
    return errorResponse(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }

  const url = new URL(context.request.url)
  const seen = new Set<string>()
  for (const name of url.searchParams.keys()) {
    if (!ALLOWED_PARAMS.has(name)) return errorResponse(400, 'unknown_parameter')
    if (seen.has(name)) return errorResponse(400, 'duplicate_parameter')
    seen.add(name)
  }
  const since = url.searchParams.get('since')
  let after: FeedPosition | null = null
  if (since !== null) {
    after = decodeFeedCursor(since)
    if (!after) return errorResponse(400, 'invalid_cursor')
  }
  const limit = parseFeedLimit(url.searchParams.get('limit'))
  if (limit === null) return errorResponse(400, 'invalid_limit')

  const store = d1FederationFeedStore(env.CATALOG_DB)
  const identity = await store.getNodeIdentity()
  if (!identity) return errorResponse(503, 'identity_missing', IDENTITY_MISSING_MESSAGE)
  const key = await loadSigningKey(env.NODE_ID_PRIVATE_KEY_PEM, identity.public_key)
  if (!key) {
    return errorResponse(503, 'signing_key_unavailable', 'This node cannot sign federation responses.')
  }

  const resolveDataRef = makeDataRefResolver(env)
  const serialize: FeedSerializer = (row, decorations, id) => {
    const dataset = wellFormed(serializeDataset(
      row,
      decorations,
      id,
      resolveDataRef,
      ref => resolveAssetRefStrict(env, ref),
      (datasetId, baseUrl) => buildFramesRedirectTemplate(env, baseUrl, datasetId),
    ))
    canonicalJson({ datasets: [dataset] })
    return dataset
  }

  const nowMs = Date.now()
  const page = wellFormed(await buildFeedPage(store, { identity, after, limit, nowMs, serialize }))
  let signed: Awaited<ReturnType<typeof signFederationBody>>
  try {
    signed = await signFederationBody(page, key, {
      keyId: identity.node_id,
      created: Math.floor(nowMs / 1000),
      target: url.pathname + url.search,
    })
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      return errorResponse(500, 'unsignable_row', 'A row on this page cannot be signed.')
    }
    throw error
  }
  return new Response(signed.text, {
    status: 200,
    headers: {
      'Content-Type': CONTENT_TYPE,
      'Cache-Control': 'no-store',
      [SIGNATURE_HEADER]: signed.header,
    },
  })
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  let response: Response
  try {
    response = await serveFeed(context)
  } catch (error) {
    // The reason goes to the log only; the caller sees the fixed 503.
    console.error('[federation/feed] publication failed', error instanceof Error ? error.message : 'UnknownError')
    response = errorResponse(503, 'feed_unavailable')
  }
  return context.request.method === 'HEAD'
    ? new Response(null, { status: response.status, headers: response.headers })
    : response
}

export const onRequestHead = onRequestGet
export const onRequest = onRequestGet
