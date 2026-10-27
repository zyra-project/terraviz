// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

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
 *     "contact": "ops@example",
 *     "abuse_contact": "abuse@example",
 *     "federation": { "feed": true }
 *   }
 *
 * `endpoints` always names all three paths, as it has since Phase 1a:
 * it says where each one lives, not whether it answers, and readers
 * already require every key. Whether the signed feed is serving is
 * `federation.feed` — true only when `FEDERATION_ENABLED` is on and
 * `FEDERATION_ABUSE_CONTACT` is a usable address, the same test the
 * feed route makes (`_lib/federation-config.ts`). `handshake` is not
 * implemented and stays a placeholder. `abuse_contact` is published
 * whenever it is set, federating or not, and `null` otherwise. Both
 * fields are additive (metadata Phase 5, step 3); a document from an
 * older node has neither, which a reader takes as "no feed".
 *
 * The document is cached for five minutes, so a node switching
 * federation on or off is seen by peers within that.
 *
 * Returns 503 with a typed envelope when the catalog DB binding is
 * missing or `node_identity` is unprovisioned, mirroring the
 * catalog API's degradation contract.
 */

import { CatalogEnv } from '../api/v1/_lib/env'
import { getNodeIdentity, IDENTITY_MISSING_MESSAGE } from '../api/v1/_lib/catalog-store'
import { computeEtag } from '../api/v1/_lib/snapshot'
import { isPublicStacUrl } from '../api/v1/_lib/stac-builders'
import { federationState, parseAbuseContact } from '../api/v1/_lib/federation-config'

const CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=600'
const CONTENT_TYPE = 'application/json; charset=utf-8'

// Exported so `scripts/build-protocol-schemas.ts` can pin this shape
// as the published `well-known.schema.json` wire contract (federation
// §7 Directive 2 / WordPress plan Phase 0).
export interface WellKnownDoc {
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
  /** Where to report abuse; `null` when the node has not set one. Absent from older nodes. */
  abuse_contact?: string | null
  /** What this node's federation surface is serving. Absent from older nodes, which serve no feed. */
  federation?: {
    /** True when `endpoints.feed` answers with signed pages. */
    feed: boolean
  }
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
      IDENTITY_MISSING_MESSAGE,
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
      // There is no handshake yet, so nothing subscribes: the feed is
      // an open read. These fields document defaults rather than
      // runtime behaviour until subscriptions exist.
      open_subscription: false,
      auto_approve: false,
      max_request_rate_per_minute: 600,
    },
    contact: identity.contact_email,
    abuse_contact: parseAbuseContact(context.env.FEDERATION_ABUSE_CONTACT),
    federation: { feed: federationState(context.env).state === 'live' },
  }

  const body = JSON.stringify(doc)
  const etag = await computeEtag(body)
  const discovery = new Headers({ ETag: etag, 'Cache-Control': CACHE_CONTROL })
  if (context.env.STAC_ENABLED === 'true' && isPublicStacUrl(identity.base_url)) {
    discovery.set('Link', `<${identity.base_url.replace(/\/$/, '')}/api/v1/stac>; rel="related"; type="application/json"; title="STAC Catalog"`)
  }
  if (context.request.headers.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: discovery,
    })
  }

  discovery.set('Content-Type', CONTENT_TYPE)
  return new Response(body, {
    status: 200,
    headers: discovery,
  })
}
