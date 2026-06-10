/**
 * GET /api/v1/publish/workflows/due — the scheduler tick (Phase Z1,
 * `docs/ZYRA_INTEGRATION_PLAN.md` §Scheduler).
 *
 * Returns workflows that are enabled, past `next_run_at`, and have
 * no active run. `.github/workflows/zyra-scheduler.yml` calls this
 * every 15 minutes with the service token, then POSTs
 * `/workflows/{id}/run` (`{ trigger: "schedule" }`) for each id —
 * the Worker owns run-row creation and the repository_dispatch (it
 * already holds GITHUB_DISPATCH_TOKEN for transcodes), so the
 * scheduler needs no GitHub credentials of its own.
 *
 * Static route segment — Pages routing matches `/due` here before
 * the dynamic `[id].ts` sibling.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import { isPrivileged } from '../../_lib/publisher-store'
import { getDueWorkflows } from '../../_lib/workflow-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return new Response(
      JSON.stringify({ error: 'binding_missing', message: 'CATALOG_DB binding is not configured on this deployment.' }),
      { status: 503, headers: { 'Content-Type': CONTENT_TYPE } },
    )
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return new Response(
      JSON.stringify({ error: 'forbidden_role', message: 'The due list is restricted to staff, admin, and service callers.' }),
      { status: 403, headers: { 'Content-Type': CONTENT_TYPE } },
    )
  }

  const rows = await getDueWorkflows(context.env.CATALOG_DB)
  // Identifiers + display fields only — the runner re-fetches the
  // full definition per run.
  return new Response(
    JSON.stringify({
      workflows: rows.map(r => ({
        id: r.id,
        name: r.name,
        schedule: r.schedule,
        next_run_at: r.next_run_at,
      })),
    }),
    { status: 200, headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' } },
  )
}
