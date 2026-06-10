/**
 * POST /api/v1/publish/workflows/{id}/runs/{run_id}/status — runner
 * lifecycle callbacks (Phase Z1, `docs/ZYRA_INTEGRATION_PLAN.md`
 * §Runner).
 *
 * Body: `{ status, gha_run_id?, upload_id?, error_summary? }` where
 * status ∈ running | succeeded | failed | canceled. Transitions are
 * validated (queued→running→terminal); an illegal transition is a
 * 409 so duplicate or out-of-order callbacks are visible rather
 * than silently absorbed. `error_summary` is truncated server-side
 * as a second line of defence behind the runner's own
 * sanitization.
 */

import type { CatalogEnv } from '../../../../../_lib/env'
import type { PublisherData } from '../../../../_middleware'
import { isPrivileged } from '../../../../../_lib/publisher-store'
import { validateRunStatusInput } from '../../../../../_lib/workflow-validators'
import { applyRunStatus, getRun } from '../../../../../_lib/workflow-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

export const onRequestPost: PagesFunction<CatalogEnv, 'id' | 'run_id'> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Run callbacks are restricted to staff, admin, and service callers.')
  }
  const idParam = context.params.id
  const runParam = context.params.run_id
  const id = (Array.isArray(idParam) ? idParam[0] : idParam) || null
  const runId = (Array.isArray(runParam) ? runParam[0] : runParam) || null
  if (!id || !runId) return jsonError(404, 'not_found', 'Run not found.')

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }
  const validation = validateRunStatusInput(body)
  if (!validation.ok) {
    return new Response(JSON.stringify({ errors: validation.errors }), {
      status: 400,
      headers: { 'Content-Type': CONTENT_TYPE },
    })
  }

  const run = await getRun(context.env.CATALOG_DB, id, runId)
  if (!run) return jsonError(404, 'not_found', 'Run not found.')

  const updated = await applyRunStatus(context.env.CATALOG_DB, run, validation.value)
  if (!updated) {
    return jsonError(
      409,
      'illegal_transition',
      `Cannot transition a ${run.status} run to ${validation.value.status}.`,
    )
  }

  return new Response(JSON.stringify({ run: updated }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}
