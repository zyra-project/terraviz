// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The public federation feed (metadata Phase 5, step 2): the page a
 * peer pulls from `GET /api/v1/federation/feed`, built from a store
 * interface rather than from D1 (federation-scoping.md §7 Directive 1).
 * The D1 implementation is `federation-feed-d1.ts`; the route wires the
 * two together and signs the result with `federation-signature.ts`.
 *
 * **What a page is.** Published, public-visibility, non-hidden rows
 * in (updated_at, id) order. Visible rows are full datasets; retracted
 * rows are tombstones. Hidden rows and their ids never enter the feed.
 *
 * **What a subscriber does with it.** Apply pages in order. A completed
 * full sync schedules a deferred sweep of rows not seen in the run. This
 * covers hard deletes, hidden rows and changes away from public visibility.
 *
 * **Why a settle watermark.** `updated_at` is stamped by the writer,
 * not by commit order, so a write that commits after a page was read
 * can carry an `updated_at` earlier than rows that page already
 * returned. A cursor past it would skip that write for good. The scan
 * therefore stops at `now - FEED_SETTLE_SECONDS`, and the final page's
 * cursor sits at that watermark: anything stamped later is still ahead
 * of the cursor on the next pull.
 *
 * **A row that cannot be served is held, not dropped.** A visible row
 * whose serialization fails is left out of `datasets` and its id goes
 * in `held`, so a subscriber keeps its last good copy rather than
 * sweeping it as gone. That covers one bad row and a broken serializer
 * alike, which the page cannot tell apart.
 *
 * **The cursor is a position, not a credential.** It is opaque only so
 * its encoding can change; anyone may build one, which is why it
 * carries no mode a client could flip to see more than the feed
 * already serves.
 */

import type { DatasetRow, DecorationRows, NodeIdentityRow } from './catalog-store'
import type { WireDataset } from './dataset-serializer'

export const FEED_SCHEMA_VERSION = 1
export const FEED_DEFAULT_LIMIT = 100
export const FEED_MAX_LIMIT = 250
/** How far behind now the scan stops, so a late-committing write
 *  stamped a little earlier is still ahead of the cursor. */
export const FEED_SETTLE_SECONDS = 30

const CURSOR_PREFIX = 'v1.'
const MAX_CURSOR_LENGTH = 512
const MAX_POSITION_FIELD = 128

/** The response body of `GET /api/v1/federation/feed`. Pinned as
 *  `public/schema/v1/feed.schema.json`. */
export interface FederationFeedBody {
  schema_version: 1
  /** The signing node's `node_id`; equals the signature's key id. */
  node_id: string
  /** The settle watermark this page was read up to (ISO 8601). */
  generated_at: string
  /** Pass back as `?since=` for the next page or the next pull. */
  cursor: string
  /** More rows are already waiting below the watermark; pull again now. */
  has_more: boolean
  datasets: WireDataset[]
  /** Ids of public, non-hidden rows that were retracted. */
  tombstones: string[]
  /** Ids of public, non-hidden rows on this page that this node could
   *  not serialize. Present only when there is one. A subscriber keeps
   *  its copy of each, unchanged and safe from a sweep, until the row
   *  can be served again. */
  held?: string[]
}

/** A point in the feed's `(updated_at, id)` order. */
export interface FeedPosition {
  updatedAt: string
  id: string
}

export interface FederatedRow {
  row: DatasetRow
  /** Whether the row is public right now (`PUBLIC_DATASET_PREDICATE`);
   *  `false` means it goes out as a tombstone. */
  visible: boolean
}

/**
 * What the feed needs from storage. Nothing here names D1 or a
 * Cloudflare type, so a second backend implements these three calls
 * and the feed is unchanged.
 */
export interface FederationFeedStore {
  getNodeIdentity(): Promise<NodeIdentityRow | null>
  /** Published, non-hidden, local-origin, `visibility = 'public'` rows strictly after `after`
   *  (or from the start), with `updated_at <= until`, ordered by
   *  `updated_at` then `id`, at most `limit` of them. */
  listFederatedRows(query: {
    nodeId: string
    after: FeedPosition | null
    until: string
    limit: number
  }): Promise<FederatedRow[]>
  /** Decorations for every id passed, an entry per id. */
  getDecorations(ids: string[]): Promise<Map<string, DecorationRows>>
}

export type FeedSerializer = (
  row: DatasetRow,
  decorations: DecorationRows,
  identity: NodeIdentityRow,
) => WireDataset

// --- cursor ------------------------------------------------------------

function toB64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64Url(s: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function isPositionField(v: unknown, allowEmpty: boolean): v is string {
  return (
    typeof v === 'string' &&
    (allowEmpty || v.length > 0) &&
    v.length <= MAX_POSITION_FIELD &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(v)
  )
}

export function encodeFeedCursor(position: FeedPosition): string {
  return CURSOR_PREFIX + toB64Url(JSON.stringify([position.updatedAt, position.id]))
}

/** Strict decode: anything not produced by `encodeFeedCursor` is `null`. */
export function decodeFeedCursor(cursor: string): FeedPosition | null {
  if (cursor.length > MAX_CURSOR_LENGTH || !cursor.startsWith(CURSOR_PREFIX)) return null
  const text = fromB64Url(cursor.slice(CURSOR_PREFIX.length))
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null
  const [updatedAt, id] = parsed
  if (!isPositionField(updatedAt, false) || !isPositionField(id, true)) return null
  return { updatedAt, id }
}

/** Parse `?limit=`: absent is the default; anything but a plain
 *  integer in `[1, FEED_MAX_LIMIT]` is `null`. */
export function parseFeedLimit(raw: string | null): number | null {
  if (raw === null) return FEED_DEFAULT_LIMIT
  if (!/^[1-9][0-9]{0,3}$/.test(raw)) return null
  const n = Number(raw)
  return n <= FEED_MAX_LIMIT ? n : null
}

function comparePosition(a: FeedPosition, b: FeedPosition): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

// --- page ----------------------------------------------------------------

export interface BuildFeedPageOptions {
  identity: NodeIdentityRow
  after: FeedPosition | null
  limit: number
  nowMs: number
  serialize: FeedSerializer
}

export async function buildFeedPage(
  store: FederationFeedStore,
  opts: BuildFeedPageOptions,
): Promise<FederationFeedBody> {
  const until = new Date(opts.nowMs - FEED_SETTLE_SECONDS * 1000).toISOString()
  const rows = await store.listFederatedRows({ nodeId: opts.identity.node_id, after: opts.after, until, limit: opts.limit + 1 })
  const hasMore = rows.length > opts.limit
  const page = rows.slice(0, opts.limit)

  const visible = page.filter(r => r.visible).map(r => r.row)
  const decorations = await store.getDecorations(visible.map(r => r.id))
  const datasets: WireDataset[] = []
  const held: string[] = []
  let failure = ''
  for (const row of visible) {
    try {
      datasets.push(opts.serialize(row, decorations.get(row.id)!, opts.identity))
    } catch (error) {
      held.push(row.id)
      // The error's name, not its message: a parse error's message can
      // quote the stored value it failed on.
      failure ||= error instanceof Error ? error.name : 'UnknownError'
    }
  }
  // Every row that cannot be serialized is held, however many there are
  // on the page, and the page still advances past them. Refusing a page
  // instead was tried, and any rule for when to refuse trades a stall
  // against a sweep: refuse on a lone bad row and it holds every pull at
  // the feed's tail, refuse only on a page of them and an author with
  // two bad rows holds the pulls, and takedowns queued behind them. So
  // the page says which rows it could not serve, and the subscriber
  // keeps its copies. A peer that does not send `held` serves pages
  // without those rows; the subscriber's sweep guard covers that case
  // (`federation-subscriber.ts`, `sweepIsPlausible`).
  if (held.length > 0) {
    console.error(
      '[federation/feed] held unserializable rows',
      held.length,
      held.slice(0, 10).join(','),
      failure,
    )
  }
  const tombstones = page.filter(r => !r.visible).map(r => r.row.id)

  const last = page.length > 0 ? page[page.length - 1].row : null
  let next: FeedPosition
  if (hasMore || (last && last.updated_at >= until)) {
    next = { updatedAt: last!.updated_at, id: last!.id }
  } else {
    // Nothing else is at or below the watermark, so the next pull can
    // start there. Never move a cursor backwards: a caller whose cursor
    // is already past this watermark (a clock step) keeps its own.
    const watermark: FeedPosition = { updatedAt: until, id: '' }
    next = opts.after && comparePosition(opts.after, watermark) > 0 ? opts.after : watermark
  }

  return {
    schema_version: FEED_SCHEMA_VERSION,
    node_id: opts.identity.node_id,
    generated_at: until,
    cursor: encodeFeedCursor(next),
    has_more: hasMore,
    datasets,
    tombstones,
    ...(held.length > 0 ? { held } : {}),
  }
}
