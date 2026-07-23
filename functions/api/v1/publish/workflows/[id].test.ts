/**
 * Wire-level tests for /api/v1/publish/workflows/{id} — read + edit
 * (issue #307). PATCH owns the save-time `next_run_at` recompute
 * (enable/schedule changes re-anchor to the wall clock; disabling
 * clears it so the due query stays index-only), so those transitions
 * are the focus.
 */

import { describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { onRequestGet as get, onRequestPatch as patch } from './[id]'
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

const WORKFLOW_ID = '01H0000000000000000000000B'
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const DUE = '2026-01-05T05:00:00.000Z'

const PIPELINE_JSON = JSON.stringify({
  stages: [
    { stage: 'acquire', command: 'ftp', args: { path: 'ftp://example.org/frames', 'sync-dir': '/work/images/frames' } },
  ],
})

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

function insertWorkflow(sqlite: Database.Database, opts: { enabled?: number; nextRunAt?: string | null } = {}): void {
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
      WORKFLOW_ID, EDITOR.id, 'Test workflow', null, PIPELINE_JSON, '{"title": "T"}',
      'P1D', opts.enabled ?? 1, datasetId, 'overwrite', null,
      opts.nextRunAt === undefined ? DUE : opts.nextRunAt,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
    )
}

function readNextRunAt(sqlite: Database.Database): string | null {
  return (sqlite.prepare('SELECT next_run_at FROM workflows WHERE id = ?').get(WORKFLOW_ID) as { next_run_at: string | null }).next_run_at
}

function makeCtx(
  env: Record<string, unknown>,
  opts: { method: 'GET' | 'PATCH'; id?: string; body?: unknown; publisher?: PublisherRow } ,
) {
  const id = opts.id ?? WORKFLOW_ID
  const url = `https://localhost/api/v1/publish/workflows/${id}`
  const headers = new Headers()
  const init: RequestInit = { method: opts.method, headers }
  if (opts.body !== undefined) {
    headers.set('Content-Type', 'application/json')
    init.body = JSON.stringify(opts.body)
  }
  return {
    request: new Request(url, init),
    env,
    params: { id },
    data: { publisher: opts.publisher ?? EDITOR },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<PagesFunction<Record<string, unknown>, 'id'>>[0]
}

describe('GET /workflows/{id}', () => {
  it('returns the workflow for capable roles, 404 for unknown ids, 403 otherwise', async () => {
    const { sqlite, env } = setupEnv()
    insertWorkflow(sqlite)

    const res = await get(makeCtx(env, { method: 'GET' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { workflow: { id: string; schedule: string } }
    expect(body.workflow).toMatchObject({ id: WORKFLOW_ID, schedule: 'P1D' })

    expect((await get(makeCtx(env, { method: 'GET', id: '01H000000000000000000MISSIN' .slice(0, 26) }))).status).toBe(404)
    expect((await get(makeCtx(env, { method: 'GET', publisher: AUTHOR }))).status).toBe(403)
  })
})

describe('PATCH /workflows/{id}', () => {
  it('recomputes next_run_at from the wall clock on schedule change', async () => {
    const { sqlite, env } = setupEnv()
    insertWorkflow(sqlite)
    const before = Date.now()

    const res = await patch(makeCtx(env, { method: 'PATCH', body: { schedule: 'PT1H' } }))
    expect(res.status).toBe(200)

    const next = readNextRunAt(sqlite)
    expect(next).not.toBeNull()
    const nextMs = Date.parse(next as string)
    expect(nextMs).toBeGreaterThanOrEqual(before + HOUR_MS - 1000)
    expect(nextMs).toBeLessThanOrEqual(Date.now() + HOUR_MS + 1000)
  })

  it('clears next_run_at on disable and re-anchors on enable', async () => {
    const { sqlite, env } = setupEnv()
    insertWorkflow(sqlite)

    expect((await patch(makeCtx(env, { method: 'PATCH', body: { enabled: false } }))).status).toBe(200)
    expect(readNextRunAt(sqlite)).toBeNull()

    const before = Date.now()
    expect((await patch(makeCtx(env, { method: 'PATCH', body: { enabled: true } }))).status).toBe(200)
    const next = readNextRunAt(sqlite)
    expect(next).not.toBeNull()
    const nextMs = Date.parse(next as string)
    expect(nextMs).toBeGreaterThanOrEqual(before + DAY_MS - 1000)
    expect(nextMs).toBeLessThanOrEqual(Date.now() + DAY_MS + 1000)
  })

  it('leaves next_run_at alone when neither schedule nor enabled change', async () => {
    const { sqlite, env } = setupEnv()
    insertWorkflow(sqlite)
    expect((await patch(makeCtx(env, { method: 'PATCH', body: { name: 'Renamed' } }))).status).toBe(200)
    expect(readNextRunAt(sqlite)).toBe(DUE)
  })

  it('rejects invalid fields and unknown target datasets without persisting', async () => {
    const { sqlite, env } = setupEnv()
    insertWorkflow(sqlite)

    expect((await patch(makeCtx(env, { method: 'PATCH', body: { schedule: 'PT5M' } }))).status).toBe(400)
    const res = await patch(
      makeCtx(env, { method: 'PATCH', body: { target_dataset_id: '01H000000000000000000000ZZ' } }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { errors: { field: string; code: string }[] }
    expect(body.errors[0]).toMatchObject({ field: 'target_dataset_id', code: 'not_found' })
    expect(readNextRunAt(sqlite)).toBe(DUE)
  })

  it('gates on workflows.manage: author 403', async () => {
    const { sqlite, env } = setupEnv()
    insertWorkflow(sqlite)
    expect((await patch(makeCtx(env, { method: 'PATCH', body: { name: 'X' }, publisher: AUTHOR }))).status).toBe(403)
  })
})
