/**
 * Wire-level tests for /api/v1/publish/workflows — list + create
 * (issue #307). Create is the allowlist's front door: pipeline JSON
 * is user-supplied execution config, so the validation refusals get
 * asserted alongside the happy path.
 */

import { describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { onRequestGet as list, onRequestPost as create } from './workflows'
import { asD1, seedFixtures } from '../_lib/test-helpers'
import type { PublisherRow } from '../_lib/publisher-store'

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

function setupEnv() {
  const sqlite = seedFixtures({ count: 1 })
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(EDITOR.id, EDITOR.email, EDITOR.display_name, EDITOR.role, EDITOR.is_admin, EDITOR.status, EDITOR.created_at)
  const datasetId = (sqlite.prepare('SELECT id FROM datasets LIMIT 1').get() as { id: string }).id
  return { sqlite, datasetId, env: { CATALOG_DB: asD1(sqlite) } }
}

function validBody(datasetId: string, overrides: Record<string, unknown> = {}) {
  return {
    name: 'SST daily',
    pipeline_json: PIPELINE_JSON,
    metadata_template: '{"title": "SST"}',
    schedule: 'P1D',
    target_dataset_id: datasetId,
    ...overrides,
  }
}

function makeCtx(
  env: Record<string, unknown>,
  opts: { method: 'GET' | 'POST'; body?: unknown; rawBody?: string; publisher?: PublisherRow } ,
) {
  const url = 'https://localhost/api/v1/publish/workflows'
  const headers = new Headers()
  const init: RequestInit = { method: opts.method, headers }
  if (opts.rawBody !== undefined) {
    headers.set('Content-Type', 'application/json')
    init.body = opts.rawBody
  } else if (opts.body !== undefined) {
    headers.set('Content-Type', 'application/json')
    init.body = JSON.stringify(opts.body)
  }
  return {
    request: new Request(url, init),
    env,
    params: {},
    data: { publisher: opts.publisher ?? EDITOR },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<PagesFunction>[0]
}

function workflowCount(sqlite: Database.Database): number {
  return (sqlite.prepare('SELECT COUNT(*) AS n FROM workflows').get() as { n: number }).n
}

describe('POST /workflows — create', () => {
  it('creates an enabled workflow with a computed next_run_at', async () => {
    const { sqlite, datasetId, env } = setupEnv()
    const before = Date.now()
    const res = await create(makeCtx(env, { method: 'POST', body: validBody(datasetId, { enabled: true }) }))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { workflow: { id: string; enabled: boolean; next_run_at: string | null } }
    expect(body.workflow.next_run_at).not.toBeNull()
    const nextMs = Date.parse(body.workflow.next_run_at as string)
    // Save-time anchor is the wall clock: now + P1D.
    expect(nextMs).toBeGreaterThanOrEqual(before + 86_400_000 - 1000)
    expect(nextMs).toBeLessThanOrEqual(Date.now() + 86_400_000 + 1000)
    expect(workflowCount(sqlite)).toBe(1)
  })

  it('defaults to disabled with no next_run_at', async () => {
    const { datasetId, env } = setupEnv()
    const res = await create(makeCtx(env, { method: 'POST', body: validBody(datasetId) }))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { workflow: { enabled: boolean; next_run_at: string | null } }
    expect(body.workflow.next_run_at).toBeNull()
  })

  it('rejects a pipeline whose stage/command is off the allowlist', async () => {
    const { sqlite, datasetId, env } = setupEnv()
    const evil = JSON.stringify({ stages: [{ stage: 'simulate', command: 'shell', args: { output: '/work/output/dataset.mp4' } }] })
    const res = await create(makeCtx(env, { method: 'POST', body: validBody(datasetId, { pipeline_json: evil }) }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { errors: { field: string }[] }
    expect(body.errors.length).toBeGreaterThan(0)
    expect(workflowCount(sqlite)).toBe(0)
  })

  it('rejects an unknown target dataset', async () => {
    const { datasetId: _unused, env } = setupEnv()
    const res = await create(
      makeCtx(env, { method: 'POST', body: validBody('01H000000000000000000000ZZ') }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { errors: { field: string; code: string }[] }
    expect(body.errors[0]).toMatchObject({ field: 'target_dataset_id', code: 'not_found' })
  })

  it('rejects malformed JSON and sub-floor schedules', async () => {
    const { datasetId, env } = setupEnv()
    expect((await create(makeCtx(env, { method: 'POST', rawBody: '{nope' }))).status).toBe(400)
    const res = await create(makeCtx(env, { method: 'POST', body: validBody(datasetId, { schedule: 'PT5M' }) }))
    expect(res.status).toBe(400)
  })

  it('gates on workflows.manage: author 403', async () => {
    const { datasetId, env } = setupEnv()
    const res = await create(makeCtx(env, { method: 'POST', body: validBody(datasetId), publisher: AUTHOR }))
    expect(res.status).toBe(403)
  })
})

describe('GET /workflows — list', () => {
  it('lists created workflows for capable roles and 403s the rest', async () => {
    const { datasetId, env } = setupEnv()
    await create(makeCtx(env, { method: 'POST', body: validBody(datasetId) }))
    const res = await list(makeCtx(env, { method: 'GET' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { workflows: { name: string }[] }
    expect(body.workflows).toHaveLength(1)
    expect(body.workflows[0].name).toBe('SST daily')

    expect((await list(makeCtx(env, { method: 'GET', publisher: AUTHOR }))).status).toBe(403)
  })
})
