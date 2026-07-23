/**
 * Wire-level tests for GET /api/v1/publish/workflows/due — the
 * scheduler tick's query (issue #307). This is the route the
 * 15-minute zyra-scheduler GHA calls; a regression here silently
 * stops (or double-fires) every scheduled workflow, so the four
 * predicate legs — enabled, non-null due, past due, no active run —
 * each get a case.
 */

import { describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { onRequestGet as due } from './due'
import { asD1, seedFixtures } from '../../_lib/test-helpers'
import type { PublisherRow } from '../../_lib/publisher-store'

const EDITOR: PublisherRow = {
  id: 'PUB-EDITOR',
  email: 'editor@example.com',
  display_name: 'Editor',
  affiliation: null,
  org_id: null,
  role: 'editor',
  is_admin: 0,
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
}
const AUTHOR: PublisherRow = { ...EDITOR, id: 'PUB-AUTHOR', email: 'author@example.com', display_name: 'Author', role: 'author' }

const PIPELINE_JSON = JSON.stringify({
  stages: [
    { stage: 'acquire', command: 'ftp', args: { path: 'ftp://example.org/frames', 'sync-dir': '/work/images/frames' } },
  ],
})

const PAST = '2026-01-05T05:00:00.000Z'
const FUTURE = '2999-01-01T00:00:00.000Z'

function setupEnv() {
  const sqlite = seedFixtures({ count: 1 })
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(EDITOR.id, EDITOR.email, EDITOR.display_name, EDITOR.role, EDITOR.is_admin, EDITOR.status, EDITOR.created_at)
  return { sqlite, env: { CATALOG_DB: asD1(sqlite) } }
}

let seq = 0
function insertWorkflow(
  sqlite: Database.Database,
  opts: { enabled?: number; nextRunAt?: string | null; name?: string } = {},
): string {
  const id = `01H000000000000000000DUE${String(seq++).padStart(2, '0')}`.slice(0, 26)
  const datasetId = (sqlite.prepare('SELECT id FROM datasets LIMIT 1').get() as { id: string }).id
  sqlite
    .prepare(
      `INSERT INTO workflows (
         id, publisher_id, name, description, pipeline_json, metadata_template,
         schedule, enabled, target_dataset_id, update_mode, last_run_at,
         next_run_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id, EDITOR.id, opts.name ?? `Workflow ${id}`, null, PIPELINE_JSON, '{"title": "T"}',
      'P1D', opts.enabled ?? 1, datasetId, 'overwrite', null,
      opts.nextRunAt === undefined ? PAST : opts.nextRunAt,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
    )
  return id
}

function insertActiveRun(sqlite: Database.Database, workflowId: string): void {
  sqlite
    .prepare(
      `INSERT INTO workflow_runs (id, workflow_id, status, "trigger", created_at)
       VALUES (?, ?, 'queued', 'schedule', ?)`,
    )
    .run('01H00000000000000000000RUN'.slice(0, 26), workflowId, '2026-01-05T05:01:00.000Z')
}

function makeCtx(env: Record<string, unknown>, publisher: PublisherRow = EDITOR) {
  const url = 'https://localhost/api/v1/publish/workflows/due'
  return {
    request: new Request(url, { method: 'GET' }),
    env,
    params: {},
    data: { publisher },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<PagesFunction>[0]
}

async function dueIds(env: Record<string, unknown>): Promise<string[]> {
  const res = await due(makeCtx(env))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { workflows: { id: string }[] }
  return body.workflows.map(w => w.id)
}

describe('GET /workflows/due', () => {
  it('gates on workflows.manage: editor 200, author 403', async () => {
    const { env } = setupEnv()
    expect((await due(makeCtx(env))).status).toBe(200)
    expect((await due(makeCtx(env, AUTHOR))).status).toBe(403)
  })

  it('returns a due workflow with identifier fields only', async () => {
    const { sqlite, env } = setupEnv()
    const id = insertWorkflow(sqlite)
    const res = await due(makeCtx(env))
    const body = (await res.json()) as { workflows: Record<string, unknown>[] }
    expect(body.workflows).toHaveLength(1)
    expect(body.workflows[0]).toEqual({
      id,
      name: expect.any(String),
      schedule: 'P1D',
      next_run_at: PAST,
    })
  })

  it('excludes disabled, future-due, and never-scheduled workflows', async () => {
    const { sqlite, env } = setupEnv()
    const dueId = insertWorkflow(sqlite)
    insertWorkflow(sqlite, { enabled: 0 })
    insertWorkflow(sqlite, { nextRunAt: FUTURE })
    insertWorkflow(sqlite, { nextRunAt: null })
    expect(await dueIds(env)).toEqual([dueId])
  })

  it('excludes a workflow with an active run (the overlap guard)', async () => {
    const { sqlite, env } = setupEnv()
    const busy = insertWorkflow(sqlite)
    insertActiveRun(sqlite, busy)
    expect(await dueIds(env)).toEqual([])
  })

  it('orders by next_run_at ascending (most-overdue first)', async () => {
    const { sqlite, env } = setupEnv()
    const later = insertWorkflow(sqlite, { nextRunAt: '2026-01-06T00:00:00.000Z' })
    const earlier = insertWorkflow(sqlite, { nextRunAt: '2026-01-04T00:00:00.000Z' })
    expect(await dueIds(env)).toEqual([earlier, later])
  })
})
