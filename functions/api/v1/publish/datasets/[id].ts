/**
 * /api/v1/publish/datasets/{id}
 *
 * GET → Single dataset full body (draft, published, retracted).
 *       Readable by any authenticated publisher — the whole node
 *       catalog is visible. 404 only when the row doesn't exist. The
 *       response carries `can_edit` so the portal knows whether to
 *       offer the mutation controls.
 * PUT → Patch metadata. Owner-scoped: only the row's publisher (or a
 *       privileged caller) may write; others get 404 from the
 *       ownership gate.
 *
 * DELETE → Hard-delete a non-published row (drafts + retracted).
 *       409 `published` for live rows (retract first) and
 *       `transcode_in_progress` for rows mid-encode.
 *
 * `publish`, `retract`, `preview` are sibling files under
 * [id]/ to keep each handler small.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import { writeDatasetAudit } from '../../_lib/audit-store'
import { getDecorations } from '../../_lib/catalog-store'
import {
  canMutateDataset,
  deleteDataset,
  getDatasetById,
  getDatasetForPublisher,
  updateDataset,
} from '../../_lib/dataset-mutations'
import { resolveHttpAssetUrl } from '../../_lib/r2-public-url'
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
  const db = context.env.CATALOG_DB!
  const row = await getDatasetById(db, id)
  if (!row) return jsonError(404, 'not_found', `Dataset ${id} not found.`)
  const decorations = (await getDecorations(db, [id])).get(id)
  // Resolve the raw `data_ref` (`r2:<key>` or a bare URL) to a
  // publicly-readable URL so the publisher portal's globe-thumbnail
  // generator can fetch the dataset's own data frame ("Generate from
  // this dataset's data") without the publisher re-uploading it.
  // Null when the ref can't be resolved (no R2_PUBLIC_BASE bound, or
  // a non-resolvable scheme) — the portal then hides the one-click
  // affordance and falls back to the manual frame picker.
  const dataUrl = resolveHttpAssetUrl(context.env, row.data_ref)
  // Same resolution for the auxiliary images so the portal can render
  // an actual preview (not just the `r2:` ref text) in the edit form.
  const thumbnailUrl = resolveHttpAssetUrl(context.env, row.thumbnail_ref)
  const legendUrl = resolveHttpAssetUrl(context.env, row.legend_ref)
  return new Response(
    JSON.stringify({
      // `can_edit` rides on the dataset object (as it does in the list
      // response) so the portal reads `dataset.can_edit` uniformly.
      dataset: { ...row, can_edit: canMutateDataset(publisher, row) },
      data_url: dataUrl,
      thumbnail_url: thumbnailUrl,
      legend_url: legendUrl,
      keywords: decorations?.keywords ?? [],
      tags: decorations?.tags ?? [],
    }),
    {
      status: 200,
      headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
    },
  )
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
  await writeDatasetAudit(
    context.env.CATALOG_DB!,
    publisher,
    'dataset.update',
    id,
    { fields: Object.keys(body as Record<string, unknown>).sort() },
  )
  return new Response(JSON.stringify({ dataset: result.dataset }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

export const onRequestDelete: PagesFunction<CatalogEnv, 'id'> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  const id = pickId(context)
  if (!id) return jsonError(400, 'invalid_request', 'Missing dataset id.')
  // Same jobQueue wiring as PUT — without it the embedding
  // deletion would silently no-op (PR #177 Copilot review).
  const jobQueue =
    (context.data as unknown as UpdateContextData).jobQueue ??
    new WaitUntilJobQueue(context.env, context.waitUntil.bind(context))
  const result = await deleteDataset(context.env, publisher, id, { jobQueue })
  if (!result.ok) return jsonError(result.status, result.error, result.message)
  await writeDatasetAudit(context.env.CATALOG_DB!, publisher, 'dataset.delete', id)
  return new Response(JSON.stringify({ deleted_id: result.deleted_id }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}
