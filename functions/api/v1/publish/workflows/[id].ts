/**
 * /api/v1/publish/workflows/{id} — single-workflow read + edit
 * (Phase Z1, `docs/ZYRA_INTEGRATION_PLAN.md` §API surface).
 *
 * GET   → `{ workflow }`. This is also what the GHA runner fetches
 *         at execution time — the dispatch payload carries only
 *         identifiers, so the runner always executes the current
 *         definition.
 * PATCH → Partial edit; re-validates supplied fields, recomputes
 *         `next_run_at` when schedule/enabled change.
 *
 * Privileged-only, like the rest of the workflow surface.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import { canManageWorkflows } from '../../_lib/capabilities'
import { writeAuditEvent } from '../../_lib/audit-store'
import { computeNextRunAt } from '../../_lib/workflow-schedule'
import { validateWorkflowInput } from '../../_lib/workflow-validators'
import {
  datasetExists,
  getWorkflow,
  toPublicWorkflow,
  updateWorkflow,
} from '../../_lib/workflow-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function forbidden(): Response {
  return jsonError(
    403,
    'forbidden_role',
    'Workflows are restricted to editor, admin, and service callers.',
  )
}

function pickId(context: Parameters<PagesFunction<CatalogEnv, 'id'>>[0]): string | null {
  const idParam = context.params.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  return id || null
}

export const onRequestGet: PagesFunction<CatalogEnv, 'id'> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!canManageWorkflows(publisher)) return forbidden()
  const id = pickId(context)
  if (!id) return jsonError(404, 'not_found', 'Workflow not found.')

  const row = await getWorkflow(context.env.CATALOG_DB, id)
  if (!row) return jsonError(404, 'not_found', 'Workflow not found.')

  return new Response(JSON.stringify({ workflow: toPublicWorkflow(row) }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

export const onRequestPatch: PagesFunction<CatalogEnv, 'id'> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!canManageWorkflows(publisher)) return forbidden()
  const id = pickId(context)
  if (!id) return jsonError(404, 'not_found', 'Workflow not found.')

  const existing = await getWorkflow(context.env.CATALOG_DB, id)
  if (!existing) return jsonError(404, 'not_found', 'Workflow not found.')

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }

  const validation = validateWorkflowInput(body, /* required */ false)
  if (!validation.ok) {
    return new Response(JSON.stringify({ errors: validation.errors }), {
      status: 400,
      headers: { 'Content-Type': CONTENT_TYPE },
    })
  }
  const value = validation.value

  if (
    value.target_dataset_id !== undefined &&
    !(await datasetExists(context.env.CATALOG_DB, value.target_dataset_id))
  ) {
    return new Response(
      JSON.stringify({
        errors: [
          {
            field: 'target_dataset_id',
            code: 'not_found',
            message: 'Target dataset does not exist on this node.',
          },
        ],
      }),
      { status: 400, headers: { 'Content-Type': CONTENT_TYPE } },
    )
  }

  // Recompute next_run_at when the cadence or the enabled flag
  // changes; disabling clears it so the due query is index-only.
  const fields: Parameters<typeof updateWorkflow>[2] = { ...value }
  const nextEnabled = value.enabled ?? existing.enabled === 1
  const nextSchedule = value.schedule ?? existing.schedule
  if (value.enabled !== undefined || value.schedule !== undefined) {
    fields.next_run_at = nextEnabled ? computeNextRunAt(nextSchedule) : null
  }

  const row = await updateWorkflow(context.env.CATALOG_DB, id, fields)
  if (!row) return jsonError(404, 'not_found', 'Workflow not found.')

  await writeAuditEvent(context.env.CATALOG_DB, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'workflow.update',
    subject_kind: 'workflow',
    subject_id: row.id,
    metadata_json: JSON.stringify({ fields: Object.keys(value) }),
  })

  return new Response(JSON.stringify({ workflow: toPublicWorkflow(row) }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}
