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
  // Seed the rows within the last few hours (relative to now), preserving
  // their relative order. The dashboards window tag/day aggregates to
  // `created_at >= now - days`, so fixed calendar dates would silently
  // drop out of the window once the wall clock passed them (a time-bomb);
  // relative timestamps always land inside any `days >= 1` window.
  const now = Date.now()
  const hoursAgo = (h: number): string => new Date(now - h * 3_600_000).toISOString()
  sqlite
    .prepare(
      `INSERT INTO feedback (rating, comment, message_id, dataset_id, conversation, tags, model_config, user_message, assistant_message, created_at)
       VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)`,
    )
    .run(
      'thumbs-up', 'great answer', 'msg-1', 'DS1', '["helpful"]',
      '{"model":"llama-3.1-70b"}', 'what is ENSO?', 'ENSO is…', hoursAgo(5),
    )
  sqlite
    .prepare(
      `INSERT INTO feedback (rating, comment, message_id, dataset_id, conversation, tags, created_at)
       VALUES (?, ?, ?, ?, '[]', ?, ?)`,
    )
    .run('thumbs-down', '', 'msg-2', null, '["wrong"]', hoursAgo(4))
  sqlite
    .prepare(
      `INSERT INTO general_feedback (kind, message, contact, platform, screenshot, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('bug', 'globe is upside down', 'a@b.c', 'web', 'data:image/jpeg;base64,abc123', hoursAgo(3))
  sqlite
    .prepare(
      `INSERT INTO general_feedback (kind, message, created_at)
       VALUES (?, ?, ?)`,
    )
    .run('feature', 'more datasets please', hoursAgo(2))
  // A standalone-widget submission (migration 0007): idea kind,
  // rating, reporter identity, meta snapshot, R2-backed screenshot.
  sqlite
    .prepare(
      `INSERT INTO general_feedback (kind, message, contact, created_at, source, rating, reporter_name, meta, screenshot_r2_key, status, country)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'idea', 'add a lightning layer', 'ada@example.com', hoursAgo(1),
      'terraviz-standalone', 4, 'Ada', '{"viewport":"800×600","dpr":1}',
      'feedback/screenshots/test-shot.png', 'new', 'US',
    )
  return { sqlite, env: { FEEDBACK_DB: asD1(sqlite) } }
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function fakeR2(storedKey: string): R2Bucket {
  return {
    async get(key: string) {
      if (key !== storedKey) return null
      return {
        body: new Response(PNG_BYTES).body,
        httpMetadata: { contentType: 'image/png' },
      }
    },
  } as unknown as R2Bucket
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
  it('503s without FEEDBACK_DB', async () => {
    expect((await feedbackGet(ctx({ env: {}, query: '?view=ai' }))).status).toBe(503)
  })

  it('is readable by a non-privileged (publisher-role) caller — read-only view access', async () => {
    const { env } = setup()
    const res = await feedbackGet(ctx({ env, publisher: PUBLISHER, query: '?view=ai' }))
    expect(res.status).toBe(200)
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
        ideaCount: number
        contentCount: number
        recentFeedback: Array<Record<string, unknown>>
      }
    }
    expect(body.data.totalCount).toBe(3)
    expect(body.data.bugCount).toBe(1)
    expect(body.data.featureCount).toBe(1)
    expect(body.data.ideaCount).toBe(1)
    expect(body.data.contentCount).toBe(0)
    const bug = body.data.recentFeedback.find(r => r.kind === 'bug')!
    expect(bug.hasScreenshot).toBe(true)
    expect(bug.screenshotIsFile).toBe(false)
    expect(bug.screenshot).toBeUndefined() // fetched on demand, never inlined
    expect(bug.message).toBe('globe is upside down')
  })

  it('exposes the standalone-widget fields on general rows', async () => {
    const { env } = setup()
    const response = await feedbackGet(ctx({ env, query: '?view=general' }))
    const body = (await response.json()) as { data: { recentFeedback: Array<Record<string, unknown>> } }
    const idea = body.data.recentFeedback.find(r => r.kind === 'idea')!
    expect(idea).toMatchObject({
      source: 'terraviz-standalone',
      rating: 4,
      reporter_name: 'Ada',
      contact: 'ada@example.com',
      status: 'new',
      country: 'US',
      hasScreenshot: true,
      screenshotIsFile: true,
      meta: { viewport: '800×600', dpr: 1 },
    })
  })

  it('streams an R2-backed screenshot via view=screenshot-file', async () => {
    const { env, sqlite } = setup()
    const ideaId = (sqlite.prepare(`SELECT id FROM general_feedback WHERE kind = 'idea'`).get() as { id: number }).id
    const withR2 = { ...env, CATALOG_R2: fakeR2('feedback/screenshots/test-shot.png') }

    const hit = await feedbackGet(ctx({ env: withR2, query: `?view=screenshot-file&id=${ideaId}` }))
    expect(hit.status).toBe(200)
    expect(hit.headers.get('Content-Type')).toBe('image/png')
    expect(new Uint8Array(await hit.arrayBuffer())).toEqual(PNG_BYTES)

    // A row without an R2 key 404s on the file view…
    const bugId = (sqlite.prepare(`SELECT id FROM general_feedback WHERE kind = 'bug'`).get() as { id: number }).id
    expect((await feedbackGet(ctx({ env: withR2, query: `?view=screenshot-file&id=${bugId}` }))).status).toBe(404)
    // …and so does a deployment without the R2 binding.
    expect((await feedbackGet(ctx({ env, query: `?view=screenshot-file&id=${ideaId}` }))).status).toBe(404)
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
