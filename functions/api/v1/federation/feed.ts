// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * GET /api/v1/federation/feed — the signed public federation feed
 * (metadata Phase 5, step 2). Off unless `FEDERATION_ENABLED` is
 * `'true'`; off, the path answers 404 as though it did not exist.
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
import {
  importNodePublicKey,
  importNodeSigningKey,
  signFederationBody,
  signingKeyMatches,
  SIGNATURE_HEADER,
} from '../_lib/federation-signature'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const ALLOWED_PARAMS = new Set(['since', 'limit'])

function errorResponse(status: number, error: string, message?: string): Response {
  return new Response(JSON.stringify(message ? { error, message } : { error }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'no-store' },
  })
}

// The checked signing key, kept for the isolate's life. Keyed by both
// strings, so rotating either the secret or the published key is
// picked up on the next request. A pair that failed is cached as
// `null` too, so a misconfigured node does not re-run the probe on
// every request.
let keyCache: { secret: string; publicKey: string; key: CryptoKey | null } | null = null

/** Test seam: forget the cached signing key. */
export function resetFeedSigningKeyCache(): void {
  keyCache = null
}

async function loadSigningKey(secret: string | undefined, publicKey: string): Promise<CryptoKey | null> {
  if (!secret) return null
  if (keyCache && keyCache.secret === secret && keyCache.publicKey === publicKey) return keyCache.key
  let key: CryptoKey | null = null
  try {
    const priv = await importNodeSigningKey(secret)
    const pub = await importNodePublicKey(publicKey)
    key = (await signingKeyMatches(priv, pub)) ? priv : null
    if (!key) console.error('[federation/feed] NODE_ID_PRIVATE_KEY_PEM is not the pair of node_identity.public_key')
  } catch (err) {
    console.error('[federation/feed] signing key unavailable:', err instanceof Error ? err.message : 'unknown error')
  }
  keyCache = { secret, publicKey, key }
  return key
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  const env = context.env
  if (env.FEDERATION_ENABLED !== 'true') return errorResponse(404, 'not_found')
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
  const serialize: FeedSerializer = (row, decorations, id) =>
    serializeDataset(
      row,
      decorations,
      id,
      resolveDataRef,
      ref => resolveAssetRefStrict(env, ref),
      (datasetId, baseUrl) => buildFramesRedirectTemplate(env, baseUrl, datasetId),
    )

  const nowMs = Date.now()
  const page = await buildFeedPage(store, { identity, after, limit, nowMs, serialize })
  const signed = await signFederationBody(page, key, {
    keyId: identity.node_id,
    created: Math.floor(nowMs / 1000),
    target: url.pathname + url.search,
  })
  return new Response(signed.text, {
    status: 200,
    headers: {
      'Content-Type': CONTENT_TYPE,
      'Cache-Control': 'no-store',
      [SIGNATURE_HEADER]: signed.header,
    },
  })
}
