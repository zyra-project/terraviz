// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The D1 implementation of the federation mirror: the peer registry
 * and the `FederationMirrorStore` the subscriber writes through
 * (`federation-subscriber.ts`). The one place the subscriber side
 * touches SQL (federation-scoping.md §7 Directive 1).
 *
 * `applyPage` and `finishFullSync` are each one `db.batch`, which D1
 * runs as a transaction: a page's rows and the cursor that follows
 * them land together or not at all, so a failure mid-page cannot save
 * a cursor past rows that were never written.
 */

import type {
  FederationMirrorStore,
  FederationPeer,
  MirrorPage,
  PeerStatus,
} from './federation-subscriber'

interface PeerRow {
  id: string
  base_url: string
  display_name: string
  public_key: string
  status: PeerStatus
  sync_interval_minutes: number
  last_sync_at: string | null
  last_sync_cursor: string | null
  last_sync_error: string | null
  full_sync_run: string | null
}

function toPeer(r: PeerRow): FederationPeer {
  return {
    id: r.id,
    baseUrl: r.base_url,
    displayName: r.display_name,
    publicKey: r.public_key,
    status: r.status,
    syncIntervalMinutes: r.sync_interval_minutes,
    lastSyncAt: r.last_sync_at,
    lastSyncCursor: r.last_sync_cursor,
    lastSyncError: r.last_sync_error,
    fullSyncRun: r.full_sync_run,
  }
}

const PEER_COLUMNS =
  'id, base_url, display_name, public_key, status, sync_interval_minutes, ' +
  'last_sync_at, last_sync_cursor, last_sync_error, full_sync_run'

export interface NewPeer {
  id: string
  baseUrl: string
  displayName: string
  publicKey: string
}

export interface FederationPeerStore {
  getPeer(id: string): Promise<FederationPeer | null>
  listPeers(): Promise<Array<FederationPeer & { mirroredCount: number }>>
  /** `exists` when the id or the base URL is already registered. */
  addPeer(peer: NewPeer, nowIso: string): Promise<'added' | 'exists'>
}

export function d1FederationPeerStore(db: D1Database): FederationPeerStore {
  return {
    async getPeer(id) {
      const row = await db
        .prepare(`SELECT ${PEER_COLUMNS} FROM federation_peers WHERE id = ?`)
        .bind(id)
        .first<PeerRow>()
      return row ? toPeer(row) : null
    },

    async listPeers() {
      const result = await db
        .prepare(
          `SELECT ${PEER_COLUMNS},
                  (SELECT COUNT(*) FROM federated_datasets f WHERE f.peer_id = p.id) AS mirrored_count
           FROM federation_peers p
           ORDER BY created_at ASC, id ASC`,
        )
        .all<PeerRow & { mirrored_count: number }>()
      return (result.results ?? []).map(r => ({ ...toPeer(r), mirroredCount: r.mirrored_count }))
    },

    async addPeer(peer, nowIso) {
      const existing = await db
        .prepare('SELECT id FROM federation_peers WHERE id = ? OR base_url = ?')
        .bind(peer.id, peer.baseUrl)
        .first<{ id: string }>()
      if (existing) return 'exists'
      try {
        await db
          .prepare(
            `INSERT INTO federation_peers
               (id, base_url, display_name, public_key, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(peer.id, peer.baseUrl, peer.displayName, peer.publicKey, nowIso, nowIso)
          .run()
      } catch (err) {
        // A concurrent add of the same peer lost the race.
        if (err instanceof Error && /UNIQUE/i.test(err.message)) return 'exists'
        throw err
      }
      return 'added'
    },
  }
}

export function d1FederationMirrorStore(db: D1Database): FederationMirrorStore {
  return {
    async applyPage(page: MirrorPage) {
      const statements: D1PreparedStatement[] = []
      const upsert = db.prepare(
        `INSERT INTO federated_datasets
           (peer_id, remote_id, origin_node, payload_json, feed_signature, seen_run, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (peer_id, remote_id) DO UPDATE SET
           origin_node = excluded.origin_node,
           payload_json = excluded.payload_json,
           feed_signature = excluded.feed_signature,
           seen_run = excluded.seen_run,
           fetched_at = excluded.fetched_at`,
      )
      for (const d of page.datasets) {
        statements.push(
          upsert.bind(
            page.peerId,
            d.remoteId,
            d.originNode,
            d.payloadJson,
            page.signature,
            page.runId,
            page.fetchedAt,
          ),
        )
      }
      const drop = db.prepare('DELETE FROM federated_datasets WHERE peer_id = ? AND remote_id = ?')
      for (const id of page.tombstones) statements.push(drop.bind(page.peerId, id))
      statements.push(
        db
          .prepare(
            `UPDATE federation_peers
             SET last_sync_cursor = ?, full_sync_run = ?, updated_at = ?
             WHERE id = ?`,
          )
          .bind(page.cursor, page.fullSyncRun, page.fetchedAt, page.peerId),
      )
      await db.batch(statements)
    },

    async finishFullSync(peerId, runId) {
      const [removed] = await db.batch([
        db
          .prepare('DELETE FROM federated_datasets WHERE peer_id = ? AND seen_run != ?')
          .bind(peerId, runId),
        db
          .prepare(
            'UPDATE federation_peers SET full_sync_run = NULL WHERE id = ? AND full_sync_run = ?',
          )
          .bind(peerId, runId),
      ])
      return removed.meta?.changes ?? 0
    },

    async recordSyncResult(peerId, { at, error }) {
      await db
        .prepare(
          `UPDATE federation_peers
           SET last_sync_at = ?, last_sync_error = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(at, error, at, peerId)
        .run()
    },
  }
}
