/**
 * /api/v1/publish/datasets/{id}
 *
 * GET → Single dataset full body (draft, published, retracted).
 *       Community publishers can only fetch rows they own; staff
 *       see anything. 404 when the row doesn't exist OR isn't
 *       visible — we don't distinguish, to avoid leaking the
 *       existence of other publishers' drafts.
 * PUT → Patch metadata. Same authorisation rule as GET.
 *
 * `publish`, `retract`, `preview` are sibling files under
 * [id]/ to keep each handler small.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import {
  getDatasetForPublisher,
  updateDataset,
} from '../../_lib/dataset-mutations'
import { type JobQueue, WaitUntilJobQueue } from '../../_lib/job-queue'

/** Test injection point — middleware/tests can pre-populate `context.data.jobQueue`. */
interface UpdateContextData extends PublisherData {
  jobQueue?: JobQueue
}

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function pickId(context: Parameters<PagesFunction<CatalogEnv, 'id'>>[0]): string | null {
  const idParam = context.params.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  return id || null
}

export const onRequestGet: PagesFunction<CatalogEnv, 'id'> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  const id = pickId(context)
  if (!id) return jsonError(400, 'invalid_request', 'Missing dataset id.')
  const row = await getDatasetForPublisher(context.env.CATALOG_DB!, publisher, id)
  if (!row) return jsonError(404, 'not_found', `Dataset ${id} not found.`)
  return new Response(JSON.stringify({ dataset: row }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

export const onRequestPut: PagesFunction<CatalogEnv, 'id'> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  const id = pickId(context)
  if (!id) return jsonError(400, 'invalid_request', 'Missing dataset id.')
  const existing = await getDatasetForPublisher(context.env.CATALOG_DB!, publisher, id)
  if (!existing) return jsonError(404, 'not_found', `Dataset ${id} not found.`)

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'Request body must be an object.')
  }

  const jobQueue =
    (context.data as unknown as UpdateContextData).jobQueue ??
    new WaitUntilJobQueue(context.env, context.waitUntil.bind(context))
  const result = await updateDataset(
    context.env,
    publisher,
    id,
    body as Record<string, unknown>,
    { jobQueue },
  )
  if (!result.ok) {
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
