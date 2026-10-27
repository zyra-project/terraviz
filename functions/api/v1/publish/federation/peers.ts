// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * GET  /api/v1/publish/federation/peers — list the peers this node
 *      subscribes to, with each one's sync state and mirrored count.
 * POST /api/v1/publish/federation/peers — subscribe to a peer.
 *
 * Metadata Phase 5, step 5b. Admin-only, and a 404 unless
 * `FEDERATION_ENABLED` is exactly `'true'`, so a node that has not
 * switched federation on exposes no federation surface at all.
 * Subscribing does not need the abuse contact the feed does: mirrored
 * rows are not served anywhere yet.
 *
 * **Adding a peer pins its key.** The body is
 * `{ base_url, node_id, public_key, display_name? }`, where the id
 * and key come from the peer's operator out of band. The route then
 * fetches the peer's `/.well-known/terraviz.json` (no redirects, a
 * byte cap, a timeout) and refuses the peer unless the document names
 * the same id, the same key and the same base URL, and says its feed
 * is serving. The discovery document is unsigned, so it is a check on
 * the operator's input and never a source of trust on its own: what
 * is stored is what the operator typed, and every later page must
 * verify against it. A key rotation is therefore a deliberate re-add,
 * not something a peer can do to this node.
 *
 * 201 on add, 409 `peer_exists` when the id or base URL is already a
 * peer (this
 * route never overwrites a pinned key), 400 with field errors for bad
 * input, 422 when the peer's discovery document disagrees, 502 when
 * it cannot be fetched. `Cache-Control: private, no-store` on every
 * response.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import { writeAuditEvent } from '../../_lib/audit-store'
import { getNodeIdentity } from '../../_lib/catalog-store'
import { importNodePublicKey } from '../../_lib/federation-signature'
import { d1FederationPeerStore } from '../../_lib/federation-mirror-d1'
import {
  federationAdminGate,
  federationError as jsonError,
  federationJson as json,
} from '../../_lib/federation-admin'
import {
  fetchPeerDiscovery,
  isFederationId,
  parsePeerBaseUrl,
} from '../../_lib/federation-subscriber'

const MAX_DISPLAY_NAME = 200

interface FieldError {
  field: string
  code: string
  message: string
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  const gate = federationAdminGate(context.env, publisher)
  if (gate) return gate
  const peers = await d1FederationPeerStore(context.env.CATALOG_DB!).listPeers()
  return json(200, {
    peers: peers.map(p => ({
      id: p.id,
      base_url: p.baseUrl,
      display_name: p.displayName,
      public_key: p.publicKey,
      status: p.status,
      last_sync_at: p.lastSyncAt,
      last_sync_error: p.lastSyncError,
      full_sync_in_progress: p.fullSyncRun !== null,
      reconcile_pending: p.sweepRun !== null,
      mirrored_count: p.mirroredCount,
    })),
  })
}

export const onRequestPost: PagesFunction<CatalogEnv> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  const gate = federationAdminGate(context.env, publisher)
  if (gate) return gate
  const db = context.env.CATALOG_DB!

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body must be JSON.')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonError(400, 'invalid_json', 'Request body must be a JSON object.')
  }
  const input = body as Record<string, unknown>

  const errors: FieldError[] = []
  const baseUrl = typeof input.base_url === 'string' ? parsePeerBaseUrl(input.base_url.replace(/\/$/, '')) : null
  if (baseUrl === null) {
    errors.push({
      field: 'base_url',
      code: 'invalid',
      message: 'Must be an https:// origin with a public host name and no path.',
    })
  }
  const nodeId = input.node_id
  if (typeof nodeId !== 'string' || !isFederationId(nodeId)) {
    errors.push({ field: 'node_id', code: 'invalid', message: 'Must be the peer\'s node id.' })
  }
  const publicKey = input.public_key
  let keyOk = false
  if (typeof publicKey === 'string' && publicKey.length <= 200) {
    try {
      await importNodePublicKey(publicKey)
      keyOk = true
    } catch {
      keyOk = false
    }
  }
  if (!keyOk) {
    errors.push({ field: 'public_key', code: 'invalid', message: 'Must be an ed25519:<base64> public key.' })
  }
  let displayName: string | null = null
  if (input.display_name !== undefined) {
    if (typeof input.display_name !== 'string' || input.display_name.trim().length === 0 || input.display_name.length > MAX_DISPLAY_NAME) {
      errors.push({ field: 'display_name', code: 'invalid', message: `Must be 1–${MAX_DISPLAY_NAME} characters.` })
    } else {
      displayName = input.display_name.trim()
    }
  }
  if (errors.length > 0) return json(400, { errors })

  const id = nodeId as string
  const key = publicKey as string
  const self = await getNodeIdentity(db)
  if (self && self.node_id === id) {
    return json(400, { errors: [{ field: 'node_id', code: 'self', message: 'A node cannot subscribe to itself.' }] })
  }

  const store = d1FederationPeerStore(db)
  if (await store.getPeer(id)) {
    return jsonError(409, 'peer_exists', 'This node is already a peer. Its pinned key is not replaced here.')
  }

  // Wrapped rather than passed bare: Workers' fetch throws
  // "Illegal invocation" when called detached from its global.
  const discovery = await fetchPeerDiscovery((i, init) => fetch(i, init), baseUrl!)
  if (!discovery.ok) {
    return json(502, {
      error: 'peer_unreachable',
      reason: discovery.error,
      ...(discovery.status !== undefined ? { status: discovery.status } : {}),
      message: 'The peer\'s /.well-known/terraviz.json could not be read.',
    })
  }
  const doc = discovery.doc
  const mismatches: string[] = []
  if (doc.nodeId !== id) mismatches.push('node_id')
  if (doc.publicKey !== key) mismatches.push('public_key')
  if (doc.baseUrl !== baseUrl) mismatches.push('base_url')
  if (mismatches.length > 0) {
    return json(422, {
      error: 'peer_mismatch',
      fields: mismatches,
      message: 'The peer\'s discovery document does not match what was entered.',
    })
  }
  if (!doc.feed) {
    return jsonError(422, 'peer_feed_off', 'The peer does not serve a federation feed.')
  }

  const name = displayName ?? (doc.displayName.trim() || id)
  const outcome = await store.addPeer(
    { id, baseUrl: baseUrl!, displayName: name, publicKey: key },
    new Date().toISOString(),
  )
  if (outcome === 'exists') {
    return jsonError(409, 'peer_exists', 'A peer with this node id or base URL is already registered.')
  }
  await writeAuditEvent(db, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'federation_peer.add',
    subject_kind: 'peer',
    subject_id: id,
    metadata_json: JSON.stringify({ base_url: baseUrl }),
  })
  return json(201, { peer: { id, base_url: baseUrl, display_name: name, status: 'active' } })
}
