/**
 * Wire-level tests for POST /api/v1/publish/workflows/{id}/run —
 * specifically the scheduled-trigger `next_run_at` bump (PR #303).
 * The schedule math has its own unit suite in
 * `_lib/workflow-schedule.test.ts`; these tests cover the wiring
 * that suite can't see: the route advancing from the *stored*
 * due-time anchor (phase preserved across dispatch jitter), the
 * wall-clock fallback for rows without an anchor, and manual runs
 * leaving the schedule untouched.
 */

import { describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { onRequestPost as run } from './run'
import { asD1, seedFixtures } from '../../../_lib/test-helpers'
import type { PublisherRow } from '../../../_lib/publisher-store'

// Workflow routes gate on `workflows.manage` (editor, admin,
// service) — see capabilities.ts and issue #305.
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

const EDITOR: PublisherRow = { ...ADMIN, id: 'PUB-EDITOR', email: 'editor@example.com', display_name: 'Editor', role: 'editor', is_admin: 0 }
const AUTHOR: PublisherRow = { ...ADMIN, id: 'PUB-AUTHOR', email: 'author@example.com', display_name: 'Author', role: 'author', is_admin: 0 }

const WORKFLOW_ID = '01H0000000000000000000000A'
const DAY_MS = 86_400_000

/** Allowlist-valid frames-output pipeline (dispatch-time
 *  re-validation runs for real in these tests). */
const PIPELINE_JSON = JSON.stringify({
  stages: [
    {
      stage: 'acquire',
      command: 'ftp',
      args: { path: 'ftp://example.org/frames', 'sync-dir': '/work/images/frames' },
    },
  ],
})

function setupEnv() {
  const sqlite = seedFixtures({ count: 1 })
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ADMIN.id, ADMIN.email, ADMIN.display_name, ADMIN.role, ADMIN.is_admin, ADMIN.status, ADMIN.created_at)
  return {
    sqlite,
    env: {
      CATALOG_DB: asD1(sqlite),
      MOCK_GITHUB_DISPATCH: 'true',
    },
  }
}

function insertWorkflow(sqlite: Database.Database, nextRunAt: string | null): void {
  const datasetId = (
    sqlite.prepare('SELECT id FROM datasets LIMIT 1').get() as { id: string }
  ).id
  sqlite
    .prepare(
      `INSERT INTO workflows (
         id, publisher_id, name, description, pipeline_json, metadata_template,
         schedule, enabled, target_dataset_id, update_mode, last_run_at,
         next_run_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      WORKFLOW_ID,
      ADMIN.id,
      'Test workflow',
      null,
      PIPELINE_JSON,
      '{"title": "Test"}',
      'P1D',
      1,
      datasetId,
      'overwrite',
      null,
      nextRunAt,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    )
}

function readNextRunAt(sqlite: Database.Database): string | null {
  return (
    sqlite.prepare('SELECT next_run_at FROM workflows WHERE id = ?').get(WORKFLOW_ID) as {
      next_run_at: string | null
    }
  ).next_run_at
}

function makeCtx(env: Record<string, unknown>, body?: unknown, publisher: PublisherRow = ADMIN) {
  const url = `https://localhost/api/v1/publish/workflows/${WORKFLOW_ID}/run`
  const headers = new Headers()
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  const init: RequestInit = { method: 'POST', headers }
  if (body !== undefined) init.body = JSON.stringify(body)
  return {
    request: new Request(url, init),
    env,
    params: { id: WORKFLOW_ID },
    data: { publisher },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<PagesFunction<Record<string, unknown>, 'id'>>[0]
}

describe('POST /workflows/{id}/run — scheduled next_run_at bump', () => {
  it('advances from the stored due-time anchor, preserving phase', async () => {
    const { sqlite, env } = setupEnv()
    // A due time well in the past with a distinctive phase
    // (05:00:00.000Z) that wall-clock arithmetic would not hit.
    const due = '2026-01-05T05:00:00.000Z'
    insertWorkflow(sqlite, due)
    const before = Date.now()

    const res = await run(makeCtx(env, { trigger: 'schedule' }))
    expect(res.status).toBe(202)

    const next = readNextRunAt(sqlite)
    expect(next).not.toBeNull()
    const nextMs = Date.parse(next as string)
    // Strictly future (the /due tick must not re-dispatch)...
    expect(nextMs).toBeGreaterThan(before)
    // ...within one period of now (no over-jump)...
    expect(nextMs).toBeLessThanOrEqual(Date.now() + DAY_MS)
    // ...and phase-locked to the anchor: an exact whole number of
    // periods from the stored due time. `now + period` (the drift
    // bug) would land at the request's wall-clock phase instead.
    expect((nextMs - Date.parse(due)) % DAY_MS).toBe(0)
  })

  it('falls back to wall-clock + period when the row has no anchor', async () => {
    const { sqlite, env } = setupEnv()
    insertWorkflow(sqlite, null)
    const before = Date.now()

    const res = await run(makeCtx(env, { trigger: 'schedule' }))
    expect(res.status).toBe(202)

    const next = readNextRunAt(sqlite)
    expect(next).not.toBeNull()
    const nextMs = Date.parse(next as string)
    expect(nextMs).toBeGreaterThanOrEqual(before + DAY_MS)
    expect(nextMs).toBeLessThanOrEqual(Date.now() + DAY_MS)
  })

  it('leaves next_run_at untouched on manual runs', async () => {
    const { sqlite, env } = setupEnv()
    const due = '2026-08-01T05:00:00.000Z'
    insertWorkflow(sqlite, due)

    // Empty body defaults to manual — the portal's Run now.
    const res = await run(makeCtx(env))
    expect(res.status).toBe(202)

    expect(readNextRunAt(sqlite)).toBe(due)
  })

  it('gates on workflows.manage: editor may trigger, author may not', async () => {
    const { sqlite, env } = setupEnv()
    insertWorkflow(sqlite, '2026-08-01T05:00:00.000Z')

    const editorRes = await run(makeCtx(env, undefined, EDITOR))
    expect(editorRes.status).toBe(202)

    const authorRes = await run(makeCtx(env, undefined, AUTHOR))
    expect(authorRes.status).toBe(403)
    const body = (await authorRes.json()) as { error: string; message: string }
    expect(body.error).toBe('forbidden_role')
    // The message names real roles now — no phantom "staff" (issue #305).
    expect(body.message).toContain('editor')
    expect(body.message).not.toContain('staff')
  })

  it('inserts a queued run row for the dispatch', async () => {
    const { sqlite, env } = setupEnv()
    insertWorkflow(sqlite, '2026-01-05T05:00:00.000Z')

    const res = await run(makeCtx(env, { trigger: 'schedule' }))
    expect(res.status).toBe(202)
    const body = (await res.json()) as { run: { status: string }; mocked: boolean }
    expect(body.run.status).toBe('queued')
    expect(body.mocked).toBe(true)

    const runRow = sqlite
      .prepare('SELECT status, "trigger" FROM workflow_runs WHERE workflow_id = ?')
      .get(WORKFLOW_ID) as { status: string; trigger: string }
    expect(runRow).toEqual({ status: 'queued', trigger: 'schedule' })
  })
})
