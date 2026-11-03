// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * DELETE /api/v1/publish/federation/peers/:id — unsubscribe from a
 * peer and drop every row mirrored from it.
 *
 * Metadata Phase 5. Admin-only and a 404 unless federation is on, the
 * same gate as the list. 404 `peer_not_found` for an unknown id;
 * otherwise 200 `{ deleted: true, removed_rows }` and an audit event.
 */

import type { CatalogEnv } from '../../../_lib/env'
import type { PublisherData } from '../../_middleware'
import { writeAuditEvent } from '../../../_lib/audit-store'
import { d1FederationPeerStore } from '../../../_lib/federation-mirror-d1'
import {
  federationAdminGate,
  federationError as jsonError,
  federationJson as json,
} from '../../../_lib/federation-admin'

export const onRequestDelete: PagesFunction<CatalogEnv> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  const gate = federationAdminGate(context.env, publisher)
  if (gate) return gate
  const id = String(context.params.id ?? '')
  const db = context.env.CATALOG_DB!
  const removed = await d1FederationPeerStore(db).removePeer(id)
  if (removed === null) return jsonError(404, 'peer_not_found', 'No peer with this id.')
  await writeAuditEvent(db, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'federation_peer.remove',
    subject_kind: 'peer',
    subject_id: id,
    metadata_json: JSON.stringify({ removed_rows: removed }),
  })
  return json(200, { deleted: true, removed_rows: removed })
}
