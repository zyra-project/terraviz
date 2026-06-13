/**
 * Wire-level tests for GET /api/v1/publish/feedback (Phase C of
 * `docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md`).
 *
 * The endpoint is a thin gate over `_feedback-helpers` (already
 * exercised in production by /api/feedback-admin), so coverage
 * focuses on the facade: binding/privilege gating, view + param
 * validation, payload pass-through for both dashboards, and the
 * screenshot path. The feedback tables live in the root
 * `migrations/` dir (not `migrations/catalog/`), so the fixture
 * applies those migrations itself.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { onRequestGet as feedbackGet } from './feedback'
import { asD1 } from '../_lib/test-helpers'
import type { PublisherRow } from '../_lib/publisher-store'

const ADMIN: PublisherRow = {
  id: 'PUB-ADMIN',
  email: 'admin@example.com',
  display_name: 'Staff',
  affiliation: null,
  org_id: null,
  role: 'admin',
  is_admin: 1,
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
}
const PUBLISHER: PublisherRow = { ...ADMIN, id: 'PUB-COMM', email: 'c@e', role: 'publisher', is_admin: 0 }

const FEEDBACK_MIGRATIONS_DIR = resolve(__dirname, '../../../../migrations')

function freshFeedbackDb(): Database.Database {
  const db = new Database(':memory:')
  const files = readdirSync(FEEDBACK_MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
  for (const file of files) {
    db.exec(readFileSync(resolve(FEEDBACK_MIGRATIONS_DIR, file), 'utf-8'))
  }
  return db
}

function setup() {
  const sqlite = freshFeedbackDb()
  sqlite
    .prepare(
      `INSERT INTO feedback (rating, comment, message_id, dataset_id, conversation, tags, model_config, user_message, assistant_message, created_at)
       VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)`,
    )
    .run(
      'thumbs-up', 'great answer', 'msg-1', 'DS1', '["helpful"]',
      '{"model":"llama-3.1-70b"}', 'what is ENSO?', 'ENSO is…', '2026-06-10T12:00:00.000Z',
    )
  sqlite
    .prepare(
      `INSERT INTO feedback (rating, comment, message_id, dataset_id, conversation, tags, created_at)
       VALUES (?, ?, ?, ?, '[]', ?, ?)`,
    )
    .run('thumbs-down', '', 'msg-2', null, '["wrong"]', '2026-06-10T13:00:00.000Z')
  sqlite
    .prepare(
      `INSERT INTO general_feedback (kind, message, contact, platform, screenshot, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('bug', 'globe is upside down', 'a@b.c', 'web', 'data:image/jpeg;base64,abc123', '2026-06-10T14:00:00.000Z')
  sqlite
    .prepare(
      `INSERT INTO general_feedback (kind, message, created_at)
       VALUES (?, ?, ?)`,
    )
    .run('feature', 'more datasets please', '2026-06-10T15:00:00.000Z')
  return { sqlite, env: { FEEDBACK_DB: asD1(sqlite) } }
}

function ctx(opts: { env: Record<string, unknown>; publisher?: PublisherRow; query: string }) {
  return {
    request: new Request(`https://localhost/api/v1/publish/feedback${opts.query}`, { method: 'GET' }),
    env: opts.env,
    params: {},
    data: { publisher: opts.publisher ?? ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/v1/publish/feedback',
  } as unknown as Parameters<typeof feedbackGet>[0]
}

describe('GET /api/v1/publish/feedback', () => {
  it('503s without FEEDBACK_DB and 403s for publisher-role callers', async () => {
    const { env } = setup()
    expect((await feedbackGet(ctx({ env: {}, query: '?view=ai' }))).status).toBe(503)
    expect((await feedbackGet(ctx({ env, publisher: PUBLISHER, query: '?view=ai' }))).status).toBe(403)
  })

  it('400s on a missing or unknown view', async () => {
    const { env } = setup()
    for (const query of ['', '?view=', '?view=sql', '?view=screenshot', '?view=screenshot&id=0', '?view=screenshot&id=abc']) {
      expect((await feedbackGet(ctx({ env, query }))).status, query).toBe(400)
    }
  })

  it('serves the AI dashboard with parsed tags and totals', async () => {
    const { env } = setup()
    const response = await feedbackGet(ctx({ env, query: '?view=ai&days=30&recent=50' }))
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      view: string
      data: {
        totalCount: number
        thumbsUpCount: number
        thumbsDownCount: number
        topTags: Array<{ tag: string; count: number }>
        recentFeedback: Array<Record<string, unknown>>
      }
    }
    expect(body.view).toBe('ai')
    expect(body.data.totalCount).toBe(2)
    expect(body.data.thumbsUpCount).toBe(1)
    expect(body.data.thumbsDownCount).toBe(1)
    expect(body.data.topTags).toEqual(
      expect.arrayContaining([
        { tag: 'helpful', count: 1 },
        { tag: 'wrong', count: 1 },
      ]),
    )
    const newest = body.data.recentFeedback[0]
    expect(newest.rating).toBe('thumbs-down')
    expect(body.data.recentFeedback[1]).toMatchObject({
      rating: 'thumbs-up',
      user_message: 'what is ENSO?',
      tags: ['helpful'],
      modelConfig: { model: 'llama-3.1-70b' },
    })
  })

  it('serves the general dashboard without inlining screenshots', async () => {
    const { env } = setup()
    const response = await feedbackGet(ctx({ env, query: '?view=general' }))
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: {
        totalCount: number
        bugCount: number
        featureCount: number
        recentFeedback: Array<Record<string, unknown>>
      }
    }
    expect(body.data.totalCount).toBe(2)
    expect(body.data.bugCount).toBe(1)
    expect(body.data.featureCount).toBe(1)
    const bug = body.data.recentFeedback.find(r => r.kind === 'bug')!
    expect(bug.hasScreenshot).toBe(true)
    expect(bug.screenshot).toBeUndefined() // fetched on demand, never inlined
    expect(bug.message).toBe('globe is upside down')
  })

  it('serves a single screenshot on demand and 404s when absent', async () => {
    const { env, sqlite } = setup()
    const bugId = (sqlite.prepare(`SELECT id FROM general_feedback WHERE kind = 'bug'`).get() as { id: number }).id
    const hit = await feedbackGet(ctx({ env, query: `?view=screenshot&id=${bugId}` }))
    expect(hit.status).toBe(200)
    expect(((await hit.json()) as { screenshot: string }).screenshot).toBe('data:image/jpeg;base64,abc123')

    const miss = await feedbackGet(ctx({ env, query: '?view=screenshot&id=9999' }))
    expect(miss.status).toBe(404)
  })
})
