/**
 * POST /api/v1/publish/workflows/{id}/run — queue one execution
 * (Phase Z1, `docs/ZYRA_INTEGRATION_PLAN.md` §API surface).
 *
 * Body: `{ trigger?: "manual" | "schedule" }` (default manual — the
 * portal's "Run now" button; the scheduler tick passes "schedule").
 *
 * Inserts a `queued` workflow_runs row, fires the `zyra-run`
 * repository_dispatch (identifiers only), and — for scheduled
 * triggers — bumps `next_run_at` so the next tick doesn't
 * re-dispatch. 409 `run_in_progress` when an active run exists;
 * the pipeline is re-validated against the current allowlist before
 * dispatch so a row saved under an older allowlist can't run.
 */

import type { CatalogEnv } from '../../../_lib/env'
import type { PublisherData } from '../../_middleware'
import { isPrivileged } from '../../../_lib/publisher-store'
import { writeAuditEvent } from '../../../_lib/audit-store'
import { isConfigurationError, safeErrorReason } from '../../../_lib/errors'
import { dispatchZyraRun, type GitHubDispatchEnv } from '../../../_lib/github-dispatch'
import { computeNextRunAt } from '../../../_lib/workflow-schedule'
import { validatePipeline, type WorkflowValidationError } from '../../../_lib/workflow-validators'
import {
  applyRunStatus,
  getWorkflow,
  insertRun,
  updateWorkflow,
} from '../../../_lib/workflow-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

export const onRequestPost: PagesFunction<CatalogEnv, 'id'> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Workflows are restricted to staff, admin, and service callers.')
  }
  const idParam = context.params.id
  const id = (Array.isArray(idParam) ? idParam[0] : idParam) || null
  if (!id) return jsonError(404, 'not_found', 'Workflow not found.')

  const workflow = await getWorkflow(context.env.CATALOG_DB, id)
  if (!workflow) return jsonError(404, 'not_found', 'Workflow not found.')

  // An empty body defaults to manual (the portal's Run now sends
  // none); malformed JSON is a 400 like every other endpoint
  // (PR #176 Copilot review).
  let trigger: 'manual' | 'schedule' = 'manual'
  const raw = await context.request.text()
  if (raw.trim().length > 0) {
    let body: { trigger?: unknown }
    try {
      body = JSON.parse(raw) as { trigger?: unknown }
    } catch {
      return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
    }
    if (body.trigger === 'schedule') trigger = 'schedule'
    else if (body.trigger !== undefined && body.trigger !== 'manual') {
      return jsonError(400, 'invalid_body', 'trigger must be "manual" or "schedule".')
    }
  }

  // Dispatch-time re-validation against the CURRENT allowlist.
  const pipelineErrors: WorkflowValidationError[] = []
  validatePipeline(workflow.pipeline_json, pipelineErrors)
  if (pipelineErrors.length > 0) {
    return new Response(JSON.stringify({ error: 'pipeline_invalid', errors: pipelineErrors }), {
      status: 409,
      headers: { 'Content-Type': CONTENT_TYPE },
    })
  }

  const inserted = await insertRun(context.env.CATALOG_DB, workflow.id, trigger)
  if ('conflict' in inserted) {
    return jsonError(409, 'run_in_progress', 'This workflow already has a queued or running execution.')
  }
  const run = inserted.run

  if (trigger === 'schedule') {
    await updateWorkflow(context.env.CATALOG_DB, workflow.id, {
      next_run_at: computeNextRunAt(workflow.schedule),
    })
  }

  let mocked = false
  try {
    const dispatched = await dispatchZyraRun(
      context.env as unknown as GitHubDispatchEnv,
      { workflow_id: workflow.id, run_id: run.id },
    )
    mocked = dispatched.mocked
  } catch (e) {
    // Dispatch failed — mark the run so it doesn't wedge the
    // active-run guard, then surface the config/upstream problem.
    await applyRunStatus(context.env.CATALOG_DB, run, {
      status: 'failed',
      gha_run_id: null,
      upload_id: null,
      error_summary: 'GitHub dispatch failed before the runner started.',
    })
    if (isConfigurationError(e)) {
      return jsonError(503, 'dispatch_unconfigured', safeErrorReason(e, 'GitHub dispatch is not configured on this deployment.'))
    }
    return jsonError(502, 'dispatch_failed', safeErrorReason(e, 'GitHub dispatch failed before the runner started.'))
  }

  await writeAuditEvent(context.env.CATALOG_DB, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'workflow.run',
    subject_kind: 'workflow',
    subject_id: workflow.id,
    metadata_json: JSON.stringify({ run_id: run.id, trigger, mocked }),
  })

  return new Response(JSON.stringify({ run, mocked }), {
    status: 202,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}
