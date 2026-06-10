/**
 * /api/v1/publish/workflows — Zyra workflow collection (Phase Z1,
 * `docs/ZYRA_INTEGRATION_PLAN.md` §API surface).
 *
 * GET  → List workflows, newest-updated first. `?limit=` (≤ 100).
 * POST → Create. Body: `{ name, pipeline_json, metadata_template,
 *        schedule, target_dataset_id, description?, enabled? }`.
 *        400 `{ errors }` for validation failures; 201 with
 *        `{ workflow }` + Location on success.
 *
 * Both privileged-only (staff / admin / service) — pipeline YAML is
 * user-supplied execution config that runs in the node's GHA, so
 * community publishers don't get the surface in v1 (plan doc
 * §Security model).
 */

import type { CatalogEnv } from '../_lib/env'
import type { PublisherData } from './_middleware'
import { isPrivileged } from '../_lib/publisher-store'
import { writeAuditEvent } from '../_lib/audit-store'
import { computeNextRunAt } from '../_lib/workflow-schedule'
import { validateWorkflowInput, type WorkflowInput } from '../_lib/workflow-validators'
import {
  datasetExists,
  insertWorkflow,
  listWorkflows,
  toPublicWorkflow,
} from '../_lib/workflow-store'

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
    'Workflows are restricted to staff, admin, and service callers.',
  )
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) return forbidden()

  const url = new URL(context.request.url)
  const limitRaw = Number(url.searchParams.get('limit') ?? '50')
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 50

  const rows = await listWorkflows(context.env.CATALOG_DB, limit)
  return new Response(JSON.stringify({ workflows: rows.map(toPublicWorkflow) }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

export const onRequestPost: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) return forbidden()

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }

  const validation = validateWorkflowInput(body, /* required */ true)
  if (!validation.ok) {
    return new Response(JSON.stringify({ errors: validation.errors }), {
      status: 400,
      headers: { 'Content-Type': CONTENT_TYPE },
    })
  }
  const value = validation.value as WorkflowInput

  if (!(await datasetExists(context.env.CATALOG_DB, value.target_dataset_id))) {
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

  const enabled = value.enabled ?? false
  const row = await insertWorkflow(context.env.CATALOG_DB, {
    publisher_id: publisher.id,
    name: value.name,
    description: value.description ?? null,
    pipeline_json: value.pipeline_json,
    metadata_template: value.metadata_template,
    schedule: value.schedule,
    enabled,
    target_dataset_id: value.target_dataset_id,
    next_run_at: enabled ? computeNextRunAt(value.schedule) : null,
  })

  await writeAuditEvent(context.env.CATALOG_DB, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'workflow.create',
    subject_kind: 'workflow',
    subject_id: row.id,
    metadata_json: JSON.stringify({
      schedule: row.schedule,
      enabled: row.enabled === 1,
      target_dataset_id: row.target_dataset_id,
    }),
  })

  return new Response(JSON.stringify({ workflow: toPublicWorkflow(row) }), {
    status: 201,
    headers: {
      'Content-Type': CONTENT_TYPE,
      Location: `/api/v1/publish/workflows/${row.id}`,
    },
  })
}
