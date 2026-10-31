// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The D1 implementation of the federation mirror: the peer registry
 * and the `FederationMirrorStore` the subscriber writes through
 * (`federation-subscriber.ts`). The one place the subscriber side
 * touches SQL (federation-scoping.md §7 Directive 1).
 *
 * `applyPage` and `finishSweep` are each one `db.batch`, which D1
 * runs as a transaction: a page's rows and the cursor that follows
 * them land together or not at all, so a failure mid-page cannot save
 * a cursor past rows that were never written.
 *
 * **One writer per peer.** Every write the subscriber makes is
 * conditional on the pull's lease (`sync_lease`, taken by
 * `acquireLease`), including each row's upsert and delete, so a second
 * pull, or one whose lease expired and was taken over, changes
 * nothing. A page whose cursor update matched no row was written by no
 * statement in its batch, and `applyPage` reports it as lost.
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
  display_name: string | null
  public_key: string
  status: PeerStatus
  last_sync_at: string | null
  last_sync_cursor: string | null
  last_sync_error: string | null
  full_sync_run: string | null
  sweep_run: string | null
  sweep_after: number | null
  sweep_flagged: number
  sync_lease_until: number | null
}

function toPeer(r: PeerRow): FederationPeer {
  return {
    id: r.id,
    baseUrl: r.base_url,
    displayName: r.display_name ?? r.id,
    publicKey: r.public_key,
    status: r.status,
    lastSyncAt: r.last_sync_at,
    lastSyncCursor: r.last_sync_cursor,
    lastSyncError: r.last_sync_error,
    fullSyncRun: r.full_sync_run,
    sweepRun: r.sweep_run,
    sweepAfterMs: r.sweep_after,
    sweepFlagged: r.sweep_flagged === 1,
    syncLeaseExpiresMs: r.sync_lease_until,
  }
}

const PEER_COLUMNS =
  'id, base_url, display_name, public_key, status, ' +
  'last_sync_at, last_sync_cursor, last_sync_error, full_sync_run, sweep_run, sweep_after, sweep_flagged, sync_lease_until'

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
  /** Remove the peer and, by cascade, every row mirrored from it.
   *  `null` when there was no such peer, else the rows removed. */
  removePeer(id: string): Promise<number | null>
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

    async removePeer(id) {
      // Delete the rows explicitly rather than trusting the cascade
      // alone: it needs `PRAGMA foreign_keys`, which D1 enforces and a
      // local SQLite may not.
      const [rows, peer] = await db.batch([
        db.prepare('DELETE FROM federated_datasets WHERE peer_id = ?').bind(id),
        db.prepare('DELETE FROM federation_peers WHERE id = ?').bind(id),
      ])
      if ((peer.meta?.changes ?? 0) === 0) return null
      return rows.meta?.changes ?? 0
    },
  }
}


/** `EXISTS` clause true only while `lease` holds the peer's lease. */
const HOLDS_LEASE = 'EXISTS (SELECT 1 FROM federation_peers WHERE id = ? AND sync_lease = ?)'

export function d1FederationMirrorStore(db: D1Database): FederationMirrorStore {
  return {
    async acquireLease(peerId, leaseId, nowMs, untilMs) {
      const taken = await db
        .prepare(
          `UPDATE federation_peers
           SET sync_lease = ?, sync_lease_until = ?
           WHERE id = ? AND (sync_lease IS NULL OR sync_lease_until IS NULL OR sync_lease_until <= ?)`,
        )
        .bind(leaseId, untilMs, peerId, nowMs)
        .run()
      if ((taken.meta?.changes ?? 0) !== 1) return null
      const row = await db
        .prepare(`SELECT ${PEER_COLUMNS} FROM federation_peers WHERE id = ? AND sync_lease = ?`)
        .bind(peerId, leaseId)
        .first<PeerRow>()
      return row ? toPeer(row) : null
    },

    async releaseLease(peerId, leaseId) {
      await db
        .prepare(
          `UPDATE federation_peers SET sync_lease = NULL, sync_lease_until = NULL
           WHERE id = ? AND sync_lease = ?`,
        )
        .bind(peerId, leaseId)
        .run()
    },

    async applyPage(page: MirrorPage) {
      const statements: D1PreparedStatement[] = []
      // INSERT … SELECT so the row is written only under the lease; the
      // WHERE also settles SQLite's parse of SELECT before ON CONFLICT.
      const upsert = db.prepare(
        `INSERT INTO federated_datasets
           (peer_id, remote_id, origin_node, payload_json, feed_signature, seen_run, fetched_at)
         SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${HOLDS_LEASE}
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
            page.peerId,
            page.leaseId,
          ),
        )
      }
      const drop = db.prepare(
        `DELETE FROM federated_datasets WHERE peer_id = ? AND remote_id = ? AND ${HOLDS_LEASE}`,
      )
      for (const id of page.tombstones) {
        statements.push(drop.bind(page.peerId, id, page.peerId, page.leaseId))
      }
      // A held row keeps its payload and signature; only the run moves,
      // so a sweep of this run keeps it.
      const hold = db.prepare(
        `UPDATE federated_datasets SET seen_run = ?
         WHERE peer_id = ? AND remote_id = ? AND ${HOLDS_LEASE}`,
      )
      for (const id of page.held) {
        statements.push(hold.bind(page.runId, page.peerId, id, page.peerId, page.leaseId))
      }
      statements.push(
        db
          .prepare(
            `UPDATE federation_peers
             SET last_sync_cursor = ?, full_sync_run = ?, updated_at = ?
             WHERE id = ? AND sync_lease = ?`,
          )
          .bind(page.cursor, page.fullSyncRun, page.fetchedAt, page.peerId, page.leaseId),
      )
      const results = await db.batch(statements)
      return (results[results.length - 1].meta?.changes ?? 0) === 1
    },

    async finishFullSync(peerId, runId, leaseId, sweepAfterMs, flagged) {
      const done = await db
        .prepare(
          `UPDATE federation_peers
           SET full_sync_run = NULL, sweep_run = ?, sweep_after = ?, sweep_flagged = ?
           WHERE id = ? AND sync_lease = ? AND full_sync_run = ?`,
        )
        .bind(runId, sweepAfterMs, flagged ? 1 : 0, peerId, leaseId, runId)
        .run()
      return (done.meta?.changes ?? 0) === 1
    },

    async countSweep(peerId, sweepRun) {
      const row = await db
        .prepare(
          `SELECT COALESCE(SUM(CASE WHEN seen_run = ? THEN 1 ELSE 0 END), 0) AS kept,
                  COALESCE(SUM(CASE WHEN seen_run != ? THEN 1 ELSE 0 END), 0) AS dropped
           FROM federated_datasets WHERE peer_id = ?`,
        )
        .bind(sweepRun, sweepRun, peerId)
        .first<{ kept: number; dropped: number }>()
      return { kept: row?.kept ?? 0, dropped: row?.dropped ?? 0 }
    },

    async refuseSweep(peerId, sweepRun, leaseId) {
      const refused = await db
        .prepare(
          `UPDATE federation_peers SET sweep_after = NULL
           WHERE id = ? AND sync_lease = ? AND sweep_run = ?`,
        )
        .bind(peerId, leaseId, sweepRun)
        .run()
      return (refused.meta?.changes ?? 0) === 1
    },

    async finishSweep(peerId, sweepRun, leaseId) {
      // Both statements test the same lease and run inside one batch, so
      // when the update matched nothing the delete removed nothing too.
      const [removed, cleared] = await db.batch([
        db
          .prepare(
            `DELETE FROM federated_datasets
             WHERE peer_id = ? AND seen_run != ?
               AND EXISTS (SELECT 1 FROM federation_peers
                           WHERE id = ? AND sync_lease = ? AND sweep_run = ?)`,
          )
          .bind(peerId, sweepRun, peerId, leaseId, sweepRun),
        db
          .prepare(
            `UPDATE federation_peers SET sweep_run = NULL, sweep_after = NULL, sweep_flagged = 0
             WHERE id = ? AND sync_lease = ? AND sweep_run = ?`,
          )
          .bind(peerId, leaseId, sweepRun),
      ])
      if ((cleared.meta?.changes ?? 0) !== 1) return null
      return removed.meta?.changes ?? 0
    },

    async recordSyncResult(peerId, leaseId, { at, error }) {
      await db
        .prepare(
          `UPDATE federation_peers
           SET last_sync_at = ?, last_sync_error = ?, updated_at = ?
           WHERE id = ? AND sync_lease = ?`,
        )
        .bind(at, error, at, peerId, leaseId)
        .run()
    },
  }
}