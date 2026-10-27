// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * POST /api/v1/publish/federation/sync — pull one peer's feed now.
 *
 * Metadata Phase 5, step 5b. Body `{ peer_id, full? }`. Runs one
 * bounded `pullPeer` (at most `PULL_MAX_PAGES` pages, each verified
 * against the peer's pinned key) and answers with its `PullResult`.
 * There is no scheduler yet, so this is how a mirror is refreshed;
 * a full sync that runs out of pages resumes on the next call.
 *
 * Admin-only, and a 404 unless `FEDERATION_ENABLED` is `'true'`, by
 * the same gate as `peers.ts`. 404 `peer_not_found` for an unknown
 * peer, 409 `peer_not_active` for one that is paused or blocked. A
 * pull that fails still answers 200: the request succeeded, the peer
 * did not, and the result names why (the same code is stored as the
 * peer's `last_sync_error`).
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import { writeAuditEvent } from '../../_lib/audit-store'
import { newUlid } from '../../_lib/ulid'
import { d1FederationMirrorStore, d1FederationPeerStore } from '../../_lib/federation-mirror-d1'
import {
  federationAdminGate,
  federationError as jsonError,
  federationJson as json,
} from '../../_lib/federation-admin'
import { isFederationId, pullPeer } from '../../_lib/federation-subscriber'

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
  const errors: Array<{ field: string; code: string; message: string }> = []
  if (typeof input.peer_id !== 'string' || !isFederationId(input.peer_id)) {
    errors.push({ field: 'peer_id', code: 'invalid', message: 'Must be a peer\'s node id.' })
  }
  if (input.full !== undefined && typeof input.full !== 'boolean') {
    errors.push({ field: 'full', code: 'invalid', message: 'Must be true or false.' })
  }
  if (errors.length > 0) return json(400, { errors })

  const peerId = input.peer_id as string
  const peer = await d1FederationPeerStore(db).getPeer(peerId)
  if (!peer) return jsonError(404, 'peer_not_found', 'No peer with that node id.')
  if (peer.status !== 'active') {
    return jsonError(409, 'peer_not_active', `This peer is ${peer.status}; it is not pulled.`)
  }

  const result = await pullPeer(
    peer,
    {
      fetch: (input, init) => fetch(input, init),
      store: d1FederationMirrorStore(db),
      now: () => Date.now(),
      newRunId: () => newUlid(),
    },
    { full: input.full === true },
  )

  await writeAuditEvent(db, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'federation_peer.sync',
    subject_kind: 'peer',
    subject_id: peerId,
    metadata_json: JSON.stringify({
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
      full: result.full,
      complete: result.complete,
      upserted: result.upserted,
      tombstoned: result.tombstoned,
      reconciled: result.reconciled,
    }),
  })
  return json(200, { result })
}
