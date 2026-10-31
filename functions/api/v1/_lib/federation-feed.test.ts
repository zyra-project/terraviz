// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project
// @vitest-environment node

/**
 * The feed's pure layer: the cursor codec, the limit parse, and how a
 * page is cut from a store — the settle watermark, tombstones, and a
 * cursor that never moves backwards. The store is a fake over an
 * in-memory list, so every case states its rows outright.
 */

import { describe, expect, it } from 'vitest'
import type { DatasetRow, DecorationRows, NodeIdentityRow } from './catalog-store'
import type { WireDataset } from './dataset-serializer'
import {
  FEED_DEFAULT_LIMIT,
  FEED_MAX_LIMIT,
  FEED_SETTLE_SECONDS,
  buildFeedPage,
  decodeFeedCursor,
  encodeFeedCursor,
  parseFeedLimit,
  type FederatedRow,
  type FederationFeedStore,
  type FeedPosition,
} from './federation-feed'

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url')

/** A real cursor rewritten into the standard base64 alphabet. */
const standardAlphabetCursor = (() => {
  for (const id of ['>', '>>', '>>>', '?', '??', '???']) {
    const c = encodeFeedCursor({ updatedAt: '2026-01-01T00:00:00.000Z', id })
    if (/[-_]/.test(c)) return c.replace(/-/g, '+').replace(/_/g, '/')
  }
  throw new Error('no fixture id reached the url-safe characters')
})()

describe('feed cursor', () => {
  it('round-trips a position, including an empty and a non-ASCII id', () => {
    for (const pos of [
      { updatedAt: '2026-01-01T00:00:00.000Z', id: 'DS000AAAAAAAAAAAAAAAAAAAAA' },
      { updatedAt: '2026-01-01T00:00:00.000Z', id: '' },
      { updatedAt: '2026-01-01T00:00:00.000Z', id: 'é—✓' },
    ]) {
      const cursor = encodeFeedCursor(pos)
      expect(cursor).toMatch(/^v1\.[A-Za-z0-9_-]+$/)
      expect(decodeFeedCursor(cursor)).toEqual(pos)
    }
  })

  it.each([
    ['empty', ''],
    ['no prefix', b64url('["2026-01-01T00:00:00.000Z","x"]')],
    ['another version', 'v2.' + b64url('["2026-01-01T00:00:00.000Z","x"]')],
    ['padding', 'v1.' + Buffer.from('["a","bc"]').toString('base64')],
    ['standard alphabet', standardAlphabetCursor],
    ['impossible length', 'v1.AAAAA'],
    ['invalid UTF-8', 'v1.' + Buffer.from([0xff, 0xfe]).toString('base64url')],
    ['not JSON', 'v1.' + b64url('nope')],
    ['an object', 'v1.' + b64url('{"updatedAt":"a","id":"b"}')],
    ['one element', 'v1.' + b64url('["2026-01-01T00:00:00.000Z"]')],
    ['three elements', 'v1.' + b64url('["a","b","c"]')],
    ['a number', 'v1.' + b64url('[1,"b"]')],
    ['an empty time', 'v1.' + b64url('["","b"]')],
    ['a control character', 'v1.' + b64url('["2026\\n","b"]')],
    ['an overlong id', 'v1.' + b64url(JSON.stringify(['a', 'x'.repeat(129)]))],
    ['an overlong cursor', 'v1.' + 'A'.repeat(512)],
  ])('rejects %s', (_name, cursor) => {
    expect(decodeFeedCursor(cursor)).toBeNull()
  })
})

describe('parseFeedLimit', () => {
  it('defaults when absent', () => {
    expect(parseFeedLimit(null)).toBe(FEED_DEFAULT_LIMIT)
  })

  it.each(['1', '42', String(FEED_MAX_LIMIT)])('accepts %s', raw => {
    expect(parseFeedLimit(raw)).toBe(Number(raw))
  })

  it.each(['', '0', '01', '-1', '1.5', '1e2', ' 5', 'abc', String(FEED_MAX_LIMIT + 1), '99999'])(
    'rejects %j',
    raw => {
      expect(parseFeedLimit(raw)).toBeNull()
    },
  )
})

// --- buildFeedPage over a fake store ----------------------------------------

const IDENTITY = { node_id: 'NODE000', public_key: 'ed25519:x' } as NodeIdentityRow
const NOW_MS = Date.parse('2026-02-01T00:00:00.000Z')
const UNTIL = new Date(NOW_MS - FEED_SETTLE_SECONDS * 1000).toISOString()

function row(id: string, updatedAt: string, visible = true): FederatedRow {
  return { row: { id, updated_at: updatedAt } as DatasetRow, visible }
}

function fakeStore(rows: FederatedRow[]) {
  const calls: Array<{ nodeId: string; after: FeedPosition | null; until: string; limit: number }> = []
  const decorated: string[][] = []
  const store: FederationFeedStore = {
    getNodeIdentity: async () => IDENTITY,
    listFederatedRows: async q => {
      calls.push(q)
      const key = (r: FederatedRow) => [r.row.updated_at, r.row.id] as const
      return rows
        .filter(r => r.row.updated_at <= q.until)
        .filter(r => {
          if (!q.after) return true
          const [u, i] = key(r)
          return u > q.after.updatedAt || (u === q.after.updatedAt && i > q.after.id)
        })
        .sort((a, b) => (key(a).join('\0') < key(b).join('\0') ? -1 : 1))
        .slice(0, q.limit)
    },
    getDecorations: async ids => {
      decorated.push(ids)
      return new Map(ids.map(id => [id, {} as DecorationRows]))
    },
  }
  return { store, calls, decorated }
}

const serialize = (r: DatasetRow) => ({ id: r.id }) as unknown as WireDataset

function page(store: FederationFeedStore, after: FeedPosition | null, limit = 10) {
  return buildFeedPage(store, { identity: IDENTITY, after, limit, nowMs: NOW_MS, serialize })
}

describe('buildFeedPage', () => {
  it('skips one unserializable row without blocking progress past it', async () => {
    const { store } = fakeStore(['A', 'B', 'C'].map(id => row(id, '2026-01-01T00:00:00.000Z')))
    const body = await buildFeedPage(store, {
      identity: IDENTITY, after: null, limit: 2, nowMs: NOW_MS,
      serialize: record => {
        if (record.id === 'B') throw new Error('poison row')
        return serialize(record)
      },
    })
    expect(body.datasets.map(record => record.id)).toEqual(['A'])
    expect(body.has_more).toBe(true)
    const after = decodeFeedCursor(body.cursor)
    expect(after?.id).toBe('B')
    expect((await page(store, after)).datasets.map(record => record.id)).toEqual(['C'])
  })

  it('fails the page when every visible row fails serialization', async () => {
    const { store } = fakeStore([row('A', '2026-01-01T00:00:00.000Z')])
    await expect(buildFeedPage(store, { identity: IDENTITY, after: null, limit: 10, nowMs: NOW_MS, serialize: () => { throw new Error('broken serializer') } })).rejects.toThrow('all visible feed rows failed serialization')
  })

  it('asks for one row past the limit, up to the settle watermark', async () => {
    const { store, calls } = fakeStore([])
    await page(store, null, 7)
    expect(calls).toEqual([{ nodeId: 'NODE000', after: null, until: UNTIL, limit: 8 }])
  })

  it('serialises visible rows, tombstones the rest, and decorates only the visible', async () => {
    const { store, decorated } = fakeStore([
      row('A', '2026-01-01T00:00:00.000Z'),
      row('B', '2026-01-02T00:00:00.000Z', false),
      row('C', '2026-01-03T00:00:00.000Z'),
    ])
    const body = await page(store, null)
    expect(body.schema_version).toBe(1)
    expect(body.node_id).toBe('NODE000')
    expect(body.generated_at).toBe(UNTIL)
    expect(body.datasets.map(d => d.id)).toEqual(['A', 'C'])
    expect(body.tombstones).toEqual(['B'])
    expect(body.has_more).toBe(false)
    expect(decorated).toEqual([['A', 'C']])
  })

  it('leaves out rows inside the settle window', async () => {
    const recent = new Date(NOW_MS - 10_000).toISOString()
    const { store } = fakeStore([row('A', '2026-01-01T00:00:00.000Z'), row('B', recent)])
    const body = await page(store, null)
    expect(body.datasets.map(d => d.id)).toEqual(['A'])
    // The final cursor sits at the watermark, so B is still ahead of it.
    expect(decodeFeedCursor(body.cursor)).toEqual({ updatedAt: UNTIL, id: '' })
  })

  it('pages through ties on updated_at without a gap or a repeat', async () => {
    const t = '2026-01-05T00:00:00.000Z'
    const ids = ['A', 'B', 'C', 'D', 'E']
    const { store } = fakeStore(ids.map(id => row(id, t)))
    const seen: string[] = []
    let after: FeedPosition | null = null
    for (let i = 0; i < 10; i++) {
      const body = await page(store, after, 2)
      seen.push(...body.datasets.map(d => d.id))
      after = decodeFeedCursor(body.cursor)
      if (!body.has_more) break
    }
    expect(seen).toEqual(ids)
    expect(after).toEqual({ updatedAt: UNTIL, id: '' })
  })

  it('keeps the last row as the cursor when it sits exactly on the watermark', async () => {
    const { store } = fakeStore([row('A', UNTIL)])
    const body = await page(store, null)
    expect(body.has_more).toBe(false)
    expect(decodeFeedCursor(body.cursor)).toEqual({ updatedAt: UNTIL, id: 'A' })
  })

  it('never moves a cursor backwards', async () => {
    const future = { updatedAt: '2030-01-01T00:00:00.000Z', id: 'Z' }
    const { store } = fakeStore([row('A', '2026-01-01T00:00:00.000Z')])
    const body = await page(store, future)
    expect(body.datasets).toEqual([])
    expect(decodeFeedCursor(body.cursor)).toEqual(future)
  })

  it('moves an older cursor up to the watermark when nothing is left', async () => {
    const { store } = fakeStore([row('A', '2026-01-01T00:00:00.000Z')])
    const first = await page(store, null)
    const second = await page(store, decodeFeedCursor(first.cursor))
    expect(second.datasets).toEqual([])
    expect(second.tombstones).toEqual([])
    expect(decodeFeedCursor(second.cursor)).toEqual({ updatedAt: UNTIL, id: '' })
  })
})
