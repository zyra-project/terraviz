/**
 * D1 data layer for Zyra workflows + runs (Phase Z1,
 * `docs/ZYRA_INTEGRATION_PLAN.md` §Data model). Pure data access —
 * authorisation (privileged-only, v1) lives in the route handlers,
 * validation in `workflow-validators.ts`, schedule math in
 * `workflow-schedule.ts`.
 *
 * Concurrency model: `getDueWorkflows` excludes workflows with an
 * active (queued/running) run, and `insertRun` re-checks the same
 * predicate immediately before inserting — alongside the GHA
 * `concurrency:` group on the runner and the dataset row's
 * `transcoding` guard, that's three layers against overlapping
 * runs of one workflow.
 */

import {
  WORKFLOW_RUN_ACTIVE_STATUSES,
  type WorkflowRunStatus,
} from '../../../../src/types/zyra-workflow-constants'
import { newUlid } from './ulid'

export interface WorkflowRow {
  id: string
  publisher_id: string
  name: string
  description: string | null
  pipeline_json: string
  metadata_template: string
  schedule: string
  enabled: number
  target_dataset_id: string
  update_mode: string
  last_run_at: string | null
  next_run_at: string | null
  created_at: string
  updated_at: string
}

export interface WorkflowRunRow {
  id: string
  workflow_id: string
  status: WorkflowRunStatus
  trigger: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  gha_run_id: string | null
  upload_id: string | null
  error_summary: string | null
}

const WORKFLOW_COLUMNS =
  'id, publisher_id, name, description, pipeline_json, metadata_template, ' +
  'schedule, enabled, target_dataset_id, update_mode, last_run_at, ' +
  'next_run_at, created_at, updated_at'

const RUN_COLUMNS =
  'id, workflow_id, status, trigger, created_at, started_at, finished_at, ' +
  'gha_run_id, upload_id, error_summary'

const activeStatusPlaceholders = WORKFLOW_RUN_ACTIVE_STATUSES.map(() => '?').join(', ')

// --- Workflows ------------------------------------------------------

export async function getWorkflow(db: D1Database, id: string): Promise<WorkflowRow | null> {
  const row = await db
    .prepare(`SELECT ${WORKFLOW_COLUMNS} FROM workflows WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<WorkflowRow>()
  return row ?? null
}

export async function listWorkflows(db: D1Database, limit: number): Promise<WorkflowRow[]> {
  const result = await db
    .prepare(`SELECT ${WORKFLOW_COLUMNS} FROM workflows ORDER BY updated_at DESC LIMIT ?`)
    .bind(limit)
    .all<WorkflowRow>()
  return result.results ?? []
}

export interface InsertWorkflowInput {
  publisher_id: string
  name: string
  description: string | null
  pipeline_json: string
  metadata_template: string
  schedule: string
  enabled: boolean
  target_dataset_id: string
  next_run_at: string | null
}

export async function insertWorkflow(
  db: D1Database,
  input: InsertWorkflowInput,
): Promise<WorkflowRow> {
  const id = newUlid()
  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT INTO workflows
         (id, publisher_id, name, description, pipeline_json,
          metadata_template, schedule, enabled, target_dataset_id,
          update_mode, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'overwrite', ?, ?, ?)`,
    )
    .bind(
      id,
      input.publisher_id,
      input.name,
      input.description,
      input.pipeline_json,
      input.metadata_template,
      input.schedule,
      input.enabled ? 1 : 0,
      input.target_dataset_id,
      input.next_run_at,
      now,
      now,
    )
    .run()
  return (await getWorkflow(db, id))!
}

/** Apply a validated PATCH subset. Caller recomputes `next_run_at`
 *  when schedule/enabled changed and passes it explicitly. */
export async function updateWorkflow(
  db: D1Database,
  id: string,
  fields: Partial<{
    name: string
    description: string | null
    pipeline_json: string
    metadata_template: string
    schedule: string
    enabled: boolean
    target_dataset_id: string
    next_run_at: string | null
  }>,
): Promise<WorkflowRow | null> {
  const sets: string[] = []
  const binds: unknown[] = []
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`)
    binds.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
  }
  if (sets.length > 0) {
    sets.push('updated_at = ?')
    binds.push(new Date().toISOString())
    binds.push(id)
    await db
      .prepare(`UPDATE workflows SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...binds)
      .run()
  }
  return getWorkflow(db, id)
}

/** Workflows the scheduler tick should run: enabled, due, and with
 *  no active run in flight. */
export async function getDueWorkflows(
  db: D1Database,
  now: Date = new Date(),
): Promise<WorkflowRow[]> {
  const result = await db
    .prepare(
      `SELECT ${WORKFLOW_COLUMNS} FROM workflows w
        WHERE w.enabled = 1
          AND w.next_run_at IS NOT NULL
          AND w.next_run_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM workflow_runs r
             WHERE r.workflow_id = w.id
               AND r.status IN (${activeStatusPlaceholders})
          )
        ORDER BY w.next_run_at ASC
        LIMIT 20`,
    )
    .bind(now.toISOString(), ...WORKFLOW_RUN_ACTIVE_STATUSES)
    .all<WorkflowRow>()
  return result.results ?? []
}

// --- Runs -----------------------------------------------------------

/**
 * Insert a queued run unless the workflow already has an active
 * one. Returns `{ conflict: true }` instead of inserting when it
 * does — the route maps that to a 409.
 */
export async function insertRun(
  db: D1Database,
  workflowId: string,
  trigger: 'schedule' | 'manual',
): Promise<{ run: WorkflowRunRow } | { conflict: true }> {
  const id = newUlid()
  const now = new Date().toISOString()
  // Atomic guard-and-insert: the WHERE NOT EXISTS makes the
  // active-run check and the insert one statement, so two
  // concurrent callers can't both pass a separate SELECT and
  // double-queue (PR #176 Copilot review). meta.changes === 0
  // means the guard rejected us.
  const result = await db
    .prepare(
      `INSERT INTO workflow_runs (id, workflow_id, status, trigger, created_at)
       SELECT ?, ?, 'queued', ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM workflow_runs
           WHERE workflow_id = ? AND status IN (${activeStatusPlaceholders})
        )`,
    )
    .bind(id, workflowId, trigger, now, workflowId, ...WORKFLOW_RUN_ACTIVE_STATUSES)
    .run()
  if ((result.meta?.changes ?? 0) === 0) return { conflict: true }
  return {
    run: {
      id,
      workflow_id: workflowId,
      status: 'queued',
      trigger,
      created_at: now,
      started_at: null,
      finished_at: null,
      gha_run_id: null,
      upload_id: null,
      error_summary: null,
    },
  }
}

export async function getRun(
  db: D1Database,
  workflowId: string,
  runId: string,
): Promise<WorkflowRunRow | null> {
  const row = await db
    .prepare(`SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE id = ? AND workflow_id = ? LIMIT 1`)
    .bind(runId, workflowId)
    .first<WorkflowRunRow>()
  return row ?? null
}

export async function listRuns(
  db: D1Database,
  workflowId: string,
  limit: number,
): Promise<WorkflowRunRow[]> {
  const result = await db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM workflow_runs
        WHERE workflow_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .bind(workflowId, limit)
    .all<WorkflowRunRow>()
  return result.results ?? []
}

/** Legal status transitions for runner callbacks. */
const TRANSITIONS: Readonly<Record<string, readonly WorkflowRunStatus[]>> = {
  queued: ['running', 'failed', 'canceled'],
  running: ['succeeded', 'failed', 'canceled'],
}

/**
 * Apply a runner status callback. Sets `started_at` on `running`,
 * `finished_at` (+ the workflow's `last_run_at`) on terminal
 * statuses. Returns null when the transition is illegal — the
 * route maps that to a 409 so a duplicate/out-of-order callback is
 * visible rather than silently absorbed.
 */
export async function applyRunStatus(
  db: D1Database,
  run: WorkflowRunRow,
  input: {
    status: WorkflowRunStatus
    gha_run_id: string | null
    upload_id: string | null
    error_summary: string | null
  },
): Promise<WorkflowRunRow | null> {
  const legal = TRANSITIONS[run.status] ?? []
  if (!legal.includes(input.status)) return null

  const now = new Date().toISOString()
  const isTerminal = input.status !== 'running'
  // started_at only stamps on the running transition — a
  // queued → failed run (dispatch died before the runner started)
  // must keep started_at null (PR #176 Copilot review).
  await db
    .prepare(
      `UPDATE workflow_runs
          SET status = ?,
              started_at = CASE WHEN ? THEN COALESCE(started_at, ?) ELSE started_at END,
              finished_at = CASE WHEN ? THEN ? ELSE finished_at END,
              gha_run_id = COALESCE(?, gha_run_id),
              upload_id = COALESCE(?, upload_id),
              error_summary = COALESCE(?, error_summary)
        WHERE id = ?`,
    )
    .bind(
      input.status,
      input.status === 'running' ? 1 : 0,
      now,
      isTerminal ? 1 : 0,
      now,
      input.gha_run_id,
      input.upload_id,
      input.error_summary,
      run.id,
    )
    .run()
  if (isTerminal) {
    await db
      .prepare(`UPDATE workflows SET last_run_at = ?, updated_at = ? WHERE id = ?`)
      .bind(now, now, run.workflow_id)
      .run()
  }
  return getRun(db, run.workflow_id, run.id)
}

// --- Misc -----------------------------------------------------------

/** Does the target dataset exist? (FK is enforced by SQLite, but a
 *  pre-check turns the failure into a field error, not a 500.) */
export async function datasetExists(db: D1Database, id: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT id FROM datasets WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<{ id: string }>()
  return row !== null
}

/** Wire shape for portal/runner responses. */
export function toPublicWorkflow(row: WorkflowRow): Record<string, unknown> {
  return {
    id: row.id,
    publisher_id: row.publisher_id,
    name: row.name,
    description: row.description,
    pipeline_json: row.pipeline_json,
    metadata_template: row.metadata_template,
    schedule: row.schedule,
    enabled: row.enabled === 1,
    target_dataset_id: row.target_dataset_id,
    update_mode: row.update_mode,
    last_run_at: row.last_run_at,
    next_run_at: row.next_run_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}
