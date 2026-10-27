// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The D1 implementation of `FederationFeedStore` — the one place the
 * federation feed touches SQL, so the route and the page builder never
 * see a D1 binding (federation-scoping.md §7 Directive 1).
 *
 * The scan is every published row with `visibility = 'public'`, and a
 * `CASE` over `PUBLIC_DATASET_PREDICATE` says which of them are public
 * now. Reusing that constant rather than restating it is what keeps the
 * feed from ever serving a row the public catalog would withhold: a row
 * fails the predicate by being hidden or retracted, and goes out as a
 * tombstone. `idx_datasets_updated_at` serves the range and the order.
 */

import {
  getDecorations,
  getNodeIdentity,
  PUBLIC_DATASET_PREDICATE,
  type DatasetRow,
} from './catalog-store'
import type { FederatedRow, FederationFeedStore } from './federation-feed'

/** Rows the feed may mention at all: published, public visibility. */
const FEED_SCAN_PREDICATE = "visibility = 'public' AND published_at IS NOT NULL"

export function d1FederationFeedStore(db: D1Database): FederationFeedStore {
  return {
    getNodeIdentity: () => getNodeIdentity(db),
    getDecorations: ids => getDecorations(db, ids),
    async listFederatedRows({ after, until, limit }): Promise<FederatedRow[]> {
      const where = [FEED_SCAN_PREDICATE, 'updated_at <= ?']
      const binds: unknown[] = [until]
      if (after) {
        where.push('(updated_at > ? OR (updated_at = ? AND id > ?))')
        binds.push(after.updatedAt, after.updatedAt, after.id)
      }
      binds.push(limit)
      const result = await db
        .prepare(
          `SELECT *, CASE WHEN ${PUBLIC_DATASET_PREDICATE} THEN 1 ELSE 0 END AS feed_visible
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
