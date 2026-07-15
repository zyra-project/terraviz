/**
 * POST /api/v1/publish/datasets/{id}/retract
 *
 * Soft-delete: stamps `retracted_at` and invalidates the KV
 * snapshot. The row stays put as a tombstone for the audit trail
 * and federation tombstone fan-out (Phase 4). The public read
 * endpoint already filters retracted rows out (see Commit B's
 * `listPublicDatasets`).
 */

import type { CatalogEnv } from '../../../_lib/env'
import type { PublisherData } from '../../_middleware'
import { writeDatasetAudit } from '../../../_lib/audit-store'
import { canOwnOrAny } from '../../../_lib/capabilities'
import {
  getDatasetForPublisher,
  retractDataset,
} from '../../../_lib/dataset-mutations'
import { type JobQueue, WaitUntilJobQueue } from '../../../_lib/job-queue'

/** Test injection point — middleware/tests can pre-populate `context.data.jobQueue`. */
interface RetractContextData extends PublisherData {
  jobQueue?: JobQueue
}

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

export const onRequestPost: PagesFunction<CatalogEnv, 'id'> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  const idParam = context.params.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  if (!id) return jsonError(400, 'invalid_request', 'Missing dataset id.')

  const existing = await getDatasetForPublisher(context.env.CATALOG_DB!, publisher, id)
  if (!existing) return jsonError(404, 'not_found', `Dataset ${id} not found.`)
  // Retract is a publish-tier action (it changes public visibility) —
  // same gate as publish.
  if (!canOwnOrAny(publisher, existing.publisher_id, 'content.publish.own', 'content.publish.any')) {
    return jsonError(403, 'forbidden_role', 'Retracting requires a publishing role.')
  }

  const jobQueue =
    (context.data as unknown as RetractContextData).jobQueue ??
    new WaitUntilJobQueue(context.env, context.waitUntil.bind(context))
  const result = await retractDataset(context.env, id, { jobQueue })
  if (!result.ok) {
    // retractDataset only returns 404 today, but mirror reindex.ts
    // (1d/O) so the structural-vs-validation envelope split is
    // explicit at the route layer regardless of what the mutation
    // grows to in future.
    if (result.status === 404) {
      const e = result.errors[0]
      return jsonError(result.status, e.code, e.message)
    }
    return new Response(JSON.stringify({ errors: result.errors }), {
      status: result.status,
      headers: { 'Content-Type': CONTENT_TYPE },
    })
  }
  await writeDatasetAudit(
    context.env.CATALOG_DB!,
    publisher,
    'dataset.retract',
    id,
    { slug: result.dataset.slug },
  )
  return new Response(JSON.stringify({ dataset: result.dataset }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}
