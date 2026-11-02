// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The D1 implementation of `FederationFeedStore` — the one place the
 * federation feed touches SQL, so the route and the page builder never
 * see a D1 binding (federation-scoping.md §7 Directive 1).
 *
 * The scan is every published row whose `visibility` is `public` or
 * `federated`, and a `CASE` over `FEED_VISIBLE_PREDICATE` says which of
 * them are feed-visible now. A scanned row that is no longer
 * feed-visible — retracted — goes out as a tombstone. Hidden rows never
 * enter the scan. `idx_datasets_federation_feed` serves the range and
 * order (a two-value `visibility IN (…)` still seeks the index under
 * each value; the page is limit-bounded, so a merge across the two is
 * negligible).
 *
 * The feed's visibility predicate is deliberately **not**
 * `catalog-store`'s `PUBLIC_DATASET_PREDICATE`: a `federated` row is
 * served to subscribed peers over the feed but withheld from the public
 * catalog, so the two must differ by exactly the `federated`
 * visibility. `PUBLIC_DATASET_PREDICATE` stays public-only (the public
 * catalog must never serve a federated row); the feed composes its own
 * on top, which is what `catalog-store.ts` anticipates — "the
 * federation path can compose its own visibility predicate on top".
 */

import { getDecorations, getNodeIdentity, type DatasetRow } from './catalog-store'
import type { FederatedRow, FederationFeedStore } from './federation-feed'

/** Visibilities the feed puts on the wire: `public` and `federated`. A
 *  `federated` row is withheld from the public catalog but shared with
 *  subscribed peers; `restricted` and `private` are never served. */
const FEED_VISIBILITIES = "('public', 'federated')"

/** Rows the feed may mention at all: published, feed visibility, non-hidden.
 *  Carries retracted rows too (no `retracted_at` test here), so they go
 *  out as tombstones; `FEED_VISIBLE_PREDICATE` is what sorts full rows
 *  from tombstones. */
const FEED_SCAN_PREDICATE = `visibility IN ${FEED_VISIBILITIES} AND published_at IS NOT NULL AND is_hidden = 0`

/** A scanned row that is feed-visible *now* — a full row, not a
 *  tombstone: feed visibility, non-hidden, not retracted, published.
 *  The feed's analogue of `PUBLIC_DATASET_PREDICATE`, broadened by
 *  exactly the `federated` visibility and kept here so the public
 *  catalog predicate stays public-only. A live `federated` row is a
 *  full row; served against the public-only predicate it would have
 *  shipped as a tombstone. */
const FEED_VISIBLE_PREDICATE = `visibility IN ${FEED_VISIBILITIES} AND is_hidden = 0 AND retracted_at IS NULL AND published_at IS NOT NULL`

export function d1FederationFeedStore(db: D1Database): FederationFeedStore {
  return {
    getNodeIdentity: () => getNodeIdentity(db),
    getDecorations: ids => getDecorations(db, ids),
    async listFederatedRows({ nodeId, after, until, limit }): Promise<FederatedRow[]> {
      const where = [FEED_SCAN_PREDICATE, 'origin_node = ?', 'updated_at <= ?']
      const binds: unknown[] = [nodeId, until]
      if (after) {
        where.push('(updated_at, id) > (?, ?)')
        binds.push(after.updatedAt, after.id)
      }
      binds.push(limit)
      const result = await db
        .prepare(
          `SELECT *, CASE WHEN ${FEED_VISIBLE_PREDICATE} THEN 1 ELSE 0 END AS feed_visible
           FROM datasets
           WHERE ${where.join(' AND ')}
           ORDER BY updated_at ASC, id ASC
           LIMIT ?`,
        )
        .bind(...binds)
        .all<DatasetRow & { feed_visible: number }>()
      return (result.results ?? []).map(({ feed_visible, ...row }) => ({
        row: row as DatasetRow,
        visible: feed_visible === 1,
      }))
    },
  }
}
