// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Wire-level tests for POST /api/v1/publish/events/rematch.
 *
 * The load-bearing one is `terminates even when an event scores
 * nothing` — the failure the keyset cursor exists to prevent, and the
 * one an offset- or "needs-a-score"-based selector would fail.
 */

import { describe, expect, it } from 'vitest'
import { onRequestPost as rematchPost } from './rematch'
import { asD1, seedFixtures } from '../../_lib/test-helpers'
import type { PublisherRow } from '../../_lib/publisher-store'

const ADMIN: PublisherRow = {
  id: 'PUB-ADMIN',
  email: 'admin@example.com',
  display_name: 'Admin',
  affiliation: null,
  org_id: null,
  role: 'admin',
  is_admin: 1,
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
}
const READONLY: PublisherRow = { ...ADMIN, id: 'PUB-RO', email: 'r@e', role: 'readonly', is_admin: 0 }

/** Seed `n` events, each holding one unscored link to a real dataset. */
function setupEnv(events: number, opts: { scored?: boolean } = {}) {
  const sqlite = seedFixtures({ count: 3 })
  const datasetId = (sqlite.prepare(`SELECT id FROM datasets LIMIT 1`).get() as { id: string }).id
  const insertEvent = sqlite.prepare(
    `INSERT INTO current_events (id, origin_node, title, source_name, source_url, status, created_at, updated_at)
     VALUES (?, 'NODE000', ?, 'src', 'https://example.test/a', 'proposed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  )
  const insertLink = sqlite.prepare(
    `INSERT INTO event_dataset_links (event_id, dataset_id, match_score, signals_json, status, created_at)
     VALUES (?, ?, ?, NULL, 'proposed', '2026-01-01T00:00:00.000Z')`,
  )
  for (let i = 0; i < events; i++) {
    // Zero-padded so ascending id order is stable and predictable.
    const id = `EVT${String(i).padStart(3, '0')}`
    insertEvent.run(id, `Event ${i}`)
    insertLink.run(id, datasetId, opts.scored === true ? 0.7 : null)
  }
  return { sqlite, env: { CATALOG_DB: asD1(sqlite) }, datasetId }
}

function ctx(opts: { env: Record<string, unknown>; publisher?: PublisherRow; body?: unknown }) {
  return {
    request: new Request('https://localhost/api/v1/publish/events/rematch', {
      method: 'POST',
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    }),
    env: opts.env,
    params: {} as Record<string, string | string[]>,
    data: { publisher: opts.publisher ?? ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/v1/publish/events/rematch',
  } as unknown as Parameters<typeof rematchPost>[0]
}

describe('POST /publish/events/rematch', () => {
  it('rejects a non-privileged caller', async () => {
    const { env } = setupEnv(1)
    const res = await rematchPost(ctx({ env, publisher: READONLY }))
    expect(res.status).toBe(403)
  })

  it('503s when CATALOG_DB is unbound', async () => {
    const res = await rematchPost(ctx({ env: {} }))
    expect(res.status).toBe(503)
  })

  it('rejects a malformed body rather than silently restarting the walk', async () => {
    // A caller that typoed the cursor field would otherwise get a
    // default-argument run from the top of the walk on every call.
    const { env } = setupEnv(1)
    const base = ctx({ env })
    const res = await rematchPost({
      ...base,
      request: new Request('https://localhost/api/v1/publish/events/rematch', {
        method: 'POST',
        body: '{ not json',
      }),
    } as unknown as Parameters<typeof rematchPost>[0])
    expect(res.status).toBe(400)
  })

  it('accepts an empty body and runs with defaults', async () => {
    const { env } = setupEnv(1)
    const res = await rematchPost(ctx({ env }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { scanned: number }).scanned).toBe(1)
  })

  it('rejects a non-string cursor', async () => {
    const { env } = setupEnv(1)
    const res = await rematchPost(ctx({ env, body: { after: 42 } }))
    expect(res.status).toBe(400)
  })

  it('re-scores the unscored events and reports done on a short page', async () => {
    const { env } = setupEnv(3)
    const res = await rematchPost(ctx({ env, body: { limit: 25 } }))
    expect(res.status).toBe(200)
    const out = (await res.json()) as { scanned: number; rescored: number; done: boolean; nextCursor: string | null }
    expect(out.scanned).toBe(3)
    expect(out.rescored).toBe(3)
    expect(out.done).toBe(true)
    expect(out.nextCursor).toBeNull()
  })

  it('pages: a full page returns a cursor, and the next call resumes past it', async () => {
    const { env } = setupEnv(3)
    const first = await rematchPost(ctx({ env, body: { limit: 2 } }))
    const a = (await first.json()) as { scanned: number; done: boolean; nextCursor: string | null }
    expect(a.scanned).toBe(2)
    expect(a.done).toBe(false)
    expect(a.nextCursor).toBe('EVT001')

    const second = await rematchPost(ctx({ env, body: { limit: 2, after: a.nextCursor } }))
    const b = (await second.json()) as { scanned: number; done: boolean }
    expect(b.scanned).toBe(1)
    expect(b.done).toBe(true)
  })

  it('terminates even when an event scores nothing', async () => {
    // The reason paging is keyset rather than "events still lacking a
    // score". With no candidate clearing the floor the links stay NULL,
    // so a selector that re-queries the unscored set would hand back
    // the same event forever. Walking by id must still finish.
    const { sqlite, env } = setupEnv(3)
    // Hide every dataset, so the matcher has nothing to propose and no
    // link gains a score on any pass.
    sqlite.prepare(`UPDATE datasets SET is_hidden = 1`).run()

    let cursor: string | null = null
    let calls = 0
    let scannedTotal = 0
    for (;;) {
      calls += 1
      expect(calls).toBeLessThan(10) // fails loudly instead of hanging
      const res = await rematchPost(ctx({ env, body: { limit: 2, after: cursor } }))
      const out = (await res.json()) as { scanned: number; done: boolean; nextCursor: string | null }
      scannedTotal += out.scanned
      if (out.done) break
      cursor = out.nextCursor
    }
    expect(scannedTotal).toBe(3)
    expect(calls).toBe(2)

    // And the links are still unscored — the walk finished without
    // inventing a score for an event that has no match.
    const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM event_dataset_links WHERE match_score IS NULL`).get() as { n: number }
    expect(row.n).toBe(3)
  })

  it('unscoredOnly false walks every event, including already-scored ones', async () => {
    const { env } = setupEnv(3, { scored: true })
    const skipped = await rematchPost(ctx({ env, body: {} }))
    expect(((await skipped.json()) as { scanned: number }).scanned).toBe(0)

    const all = await rematchPost(ctx({ env, body: { unscoredOnly: false } }))
    expect(((await all.json()) as { scanned: number }).scanned).toBe(3)
  })

  it('writes an audit row naming the rematch path', async () => {
    const { sqlite, env } = setupEnv(2)
    await rematchPost(ctx({ env }))
    const row = sqlite
      .prepare(`SELECT action, metadata_json FROM audit_events ORDER BY created_at DESC LIMIT 1`)
      .get() as { action: string; metadata_json: string } | undefined
    expect(row?.action).toBe('event.refreshed')
    expect(JSON.parse(row?.metadata_json ?? '{}')).toMatchObject({ via: 'rematch', scanned: 2 })
  })
})
