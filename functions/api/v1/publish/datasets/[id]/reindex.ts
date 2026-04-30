/**
 * POST /api/v1/publish/datasets/{id}/reindex
 *
 * Re-enqueues the embed job for an already-published dataset
 * without re-running the row's content through the publish
 * lifecycle. Phase 1d/D ships this so an operator who wires up
 * Vectorize after publishing some rows can backfill the vector
 * index, and so a future model-version bump can be rolled out as
 * a one-off cron that walks every row and POSTs reindex.
 *
 * Error envelope: structural errors (404 not_found, 503
 * embed_unconfigured) translate to `{error, message}` to match
 * publish/retract; the structured 409 not_published conflict
 * stays as `{errors: [...]}` so the CLI's per-error printing
 * surfaces the field/code/message tuple. Pre-1d/O the route
 * returned `{errors}` for every non-OK path, which made the CLI
 * collapse to `error: "http_error"` instead of the meaningful
 * code.
 *
 * 1d/O originally pre-checked visibility in the route via
 * `getDatasetForPublisher` (mirroring publish.ts), but
 * `reindexDataset` also does that lookup internally — the dual
 * fetch was redundant. 1d/P drops the pre-check and translates
 * the mutation's 404 outcome into the same envelope.
 */

import type { CatalogEnv } from '../../../_lib/env'
import type { PublisherData } from '../../_middleware'
import { reindexDataset } from '../../../_lib/dataset-mutations'
import { type JobQueue, WaitUntilJobQueue } from '../../../_lib/job-queue'

interface ReindexContextData extends PublisherData {
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

  const jobQueue =
    (context.data as unknown as ReindexContextData).jobQueue ??
    new WaitUntilJobQueue(context.env, context.waitUntil.bind(context))
  const result = await reindexDataset(context.env, publisher, id, { jobQueue })
  if (!result.ok) {
    // Structural errors collapse to {error, message}; the
    // structured 409 not_published conflict keeps {errors} so the
    // CLI surfaces field/code/message.
    if (result.status === 404 || result.status === 503) {
      const e = result.errors[0]
      return jsonError(result.status, e.code, e.message)
    }
    return new Response(JSON.stringify({ errors: result.errors }), {
      status: result.status,
      headers: { 'Content-Type': CONTENT_TYPE },
    })
  }
  return new Response(JSON.stringify({ dataset: result.dataset }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}
