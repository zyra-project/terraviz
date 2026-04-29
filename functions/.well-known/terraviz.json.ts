/**
 * Cloudflare Pages Function — GET /.well-known/terraviz.json
 *
 * Service-discovery document for federation (Phase 4) and any
 * out-of-band tool that wants to know what API surface a node
 * advertises. The wire shape is defined in `CATALOG_BACKEND_PLAN.md`
 * "The well-known document":
 *
 *   {
 *     "node_id": "01H...",
 *     "display_name": "Terraviz (dev)",
 *     "base_url": "https://...",
 *     "public_key": "ed25519:...",
 *     "schema_versions_supported": [1],
 *     "endpoints": { "catalog": "/api/v1/catalog", ... },
 *     "policy": { "open_subscription": false, ... },
 *     "contact": "ops@example"
 *   }
 *
 * Phase 1a only implements the `catalog` endpoint; `feed` and
 * `handshake` are advertised as forward-compatible placeholders so
 * a federation subscriber's discovery probe sees the canonical
 * paths even before they accept traffic. Phase 4 wires them up
 * without changing the doc shape.
 *
 * Returns 503 with a typed envelope when the catalog DB binding is
 * missing or `node_identity` is unprovisioned, mirroring the
 * catalog API's degradation contract.
 */

import { CatalogEnv } from '../api/v1/_lib/env'
import { getNodeIdentity } from '../api/v1/_lib/catalog-store'
import { computeEtag } from '../api/v1/_lib/snapshot'

const CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=600'
const CONTENT_TYPE = 'application/json; charset=utf-8'

interface WellKnownDoc {
  node_id: string
  display_name: string
  base_url: string
  public_key: string
  schema_versions_supported: number[]
  endpoints: {
    catalog: string
    feed: string
    handshake: string
  }
  policy: {
    open_subscription: boolean
    auto_approve: boolean
    max_request_rate_per_minute: number
  }
  contact: string | null
}

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(
      503,
      'binding_missing',
      'CATALOG_DB binding is not configured on this deployment.',
    )
  }

  const identity = await getNodeIdentity(context.env.CATALOG_DB)
  if (!identity) {
    return jsonError(
      503,
      'identity_missing',
      'Node identity has not been provisioned. Run `npm run gen:node-key`.',
    )
  }

  const doc: WellKnownDoc = {
    node_id: identity.node_id,
    display_name: identity.display_name,
    base_url: identity.base_url,
    public_key: identity.public_key,
    schema_versions_supported: [1],
    endpoints: {
      catalog: '/api/v1/catalog',
      feed: '/api/v1/federation/feed',
      handshake: '/api/v1/federation/handshake',
    },
    policy: {
      // Federation goes live in Phase 4. Until then, the policy
      // fields document defaults rather than runtime behaviour.
      open_subscription: false,
      auto_approve: false,
      max_request_rate_per_minute: 600,
    },
    contact: identity.contact_email,
  }

  const body = JSON.stringify(doc)
  const etag = await computeEtag(body)
  if (context.request.headers.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': CACHE_CONTROL },
    })
  }

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': CONTENT_TYPE,
      ETag: etag,
      'Cache-Control': CACHE_CONTROL,
    },
  })
}
