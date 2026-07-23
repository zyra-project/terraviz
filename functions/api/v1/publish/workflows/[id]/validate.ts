/**
 * POST /api/v1/publish/workflows/{id}/validate — static dry-run
 * (Phase Z1, `docs/ZYRA_INTEGRATION_PLAN.md` §API surface).
 *
 * Validates a candidate body WITHOUT persisting — the portal's
 * Validate button. Body: any subset of the create fields; supplied
 * fields are checked, the stored row is otherwise untouched (the
 * `{id}` exists purely so the button works from the edit page; the
 * row itself isn't read). The deeper `zyra run --dry-run` happens
 * in the runner, not the Worker — no Python at the edge.
 *
 * Response: `{ ok: true }` or `{ ok: false, errors: [...] }`, both
 * 200 — validation findings are the success payload here, not an
 * error.
 */

import type { CatalogEnv } from '../../../_lib/env'
import type { PublisherData } from '../../_middleware'
import { canManageWorkflows } from '../../../_lib/capabilities'
import { validateWorkflowInput } from '../../../_lib/workflow-validators'

const CONTENT_TYPE = 'application/json; charset=utf-8'

export const onRequestPost: PagesFunction<CatalogEnv, 'id'> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!canManageWorkflows(publisher)) {
    return new Response(
      JSON.stringify({ error: 'forbidden_role', message: 'Workflows are restricted to editor, admin, and service callers.' }),
      { status: 403, headers: { 'Content-Type': CONTENT_TYPE } },
    )
  }

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return new Response(
      JSON.stringify({ error: 'invalid_json', message: 'Request body is not valid JSON.' }),
      { status: 400, headers: { 'Content-Type': CONTENT_TYPE } },
    )
  }

  const validation = validateWorkflowInput(body, /* required */ false)
  const payload = validation.ok ? { ok: true } : { ok: false, errors: validation.errors }
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}
