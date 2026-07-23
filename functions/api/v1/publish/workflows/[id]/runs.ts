/**
 * GET /api/v1/publish/workflows/{id}/runs — run history (Phase Z1,
 * `docs/ZYRA_INTEGRATION_PLAN.md` §API surface). Newest first,
 * `?limit=` ≤ 100. Backs the portal's run-history page; the
 * `gha_run_id` field is what the UI turns into an Actions log link.
 */

import type { CatalogEnv } from '../../../_lib/env'
import type { PublisherData } from '../../_middleware'
import { canManageWorkflows } from '../../../_lib/capabilities'
import { getWorkflow, listRuns } from '../../../_lib/workflow-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

export const onRequestGet: PagesFunction<CatalogEnv, 'id'> = async context => {
  if (!context.env.CATALOG_DB) {
    return new Response(
      JSON.stringify({ error: 'binding_missing', message: 'CATALOG_DB binding is not configured on this deployment.' }),
      { status: 503, headers: { 'Content-Type': CONTENT_TYPE } },
    )
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!canManageWorkflows(publisher)) {
    return new Response(
      JSON.stringify({ error: 'forbidden_role', message: 'Workflows are restricted to editor, admin, and service callers.' }),
      { status: 403, headers: { 'Content-Type': CONTENT_TYPE } },
    )
  }
  const idParam = context.params.id
  const id = (Array.isArray(idParam) ? idParam[0] : idParam) || null
  if (!id) {
    return new Response(JSON.stringify({ error: 'not_found', message: 'Workflow not found.' }), {
      status: 404,
      headers: { 'Content-Type': CONTENT_TYPE },
    })
  }

  const workflow = await getWorkflow(context.env.CATALOG_DB, id)
  if (!workflow) {
    return new Response(JSON.stringify({ error: 'not_found', message: 'Workflow not found.' }), {
      status: 404,
      headers: { 'Content-Type': CONTENT_TYPE },
    })
  }

  const url = new URL(context.request.url)
  const limitRaw = Number(url.searchParams.get('limit') ?? '50')
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 50

  const runs = await listRuns(context.env.CATALOG_DB, id, limit)
  return new Response(JSON.stringify({ runs }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}
