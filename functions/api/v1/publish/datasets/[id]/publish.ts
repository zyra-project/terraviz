/**
 * POST /api/v1/publish/datasets/{id}/publish
 *
 * Flips a draft to published. Runs the stricter
 * `validateForPublish` rule set (see `validators.ts`); on success
 * stamps `published_at` and invalidates the KV catalog snapshot so
 * the next public read sees the change.
 *
 * Community publishers can only publish their own rows; staff see
 * everything. 404 — same as GET — when the row isn't visible.
 */

import type { CatalogEnv } from '../../../_lib/env'
import type { PublisherData } from '../../_middleware'
import { writeDatasetAudit } from '../../../_lib/audit-store'
import {
  getDatasetForPublisher,
  publishDataset,
} from '../../../_lib/dataset-mutations'
import { canOwnOrAny } from '../../../_lib/capabilities'
import { type JobQueue, WaitUntilJobQueue } from '../../../_lib/job-queue'

/** Test injection point — middleware/tests can pre-populate `context.data.jobQueue`. */
interface PublishContextData extends PublisherData {
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
  // Publishing is a privilege above editing: a contributor can draft +
  // edit its own rows but cannot make them public — an author (own) or
  // an editor/admin (any) publishes.
  if (!canOwnOrAny(publisher, existing.publisher_id, 'content.publish.own', 'content.publish.any')) {
    return jsonError(403, 'forbidden_role', 'Publishing requires a publishing role.')
  }

  const jobQueue =
    (context.data as unknown as PublishContextData).jobQueue ??
    new WaitUntilJobQueue(context.env, context.waitUntil.bind(context))
  const result = await publishDataset(context.env, id, { jobQueue })
  if (!result.ok) {
    // Structural errors collapse to {error, message}; the structured
    // 400 validateForPublish errors keep {errors} so the CLI surfaces
    // field/code/message. Mirrors reindex.ts (1d/O) — defensive
    // against the race window between the pre-check above and the
    // mutation's row lookup.
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
    'dataset.publish',
    id,
    { slug: result.dataset.slug },
  )
  return new Response(JSON.stringify({ dataset: result.dataset }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}
