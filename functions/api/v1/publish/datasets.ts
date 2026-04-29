/**
 * /api/v1/publish/datasets
 *
 * GET  → List datasets visible to the caller (`?status=`,
 *        `?cursor=`, `?limit=`). Community publishers see only
 *        their own rows; staff see everything (role-aware filter
 *        in `dataset-mutations.ts`).
 * POST → Create a new draft dataset. Body validated against the
 *        rules in `validators.ts` "validateDraftCreate". Server
 *        derives the slug from the title when missing and resolves
 *        slug collisions by appending `-N`.
 *
 * Both routes assume the publish middleware has already attached
 * `context.data.publisher`.
 */

import type { CatalogEnv } from '../_lib/env'
import type { PublisherData } from './_middleware'
import {
  createDataset,
  listDatasetsForPublisher,
  type ListOptions,
} from '../_lib/dataset-mutations'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function validationFailure(errors: unknown[], status = 400): Response {
  return new Response(JSON.stringify({ errors }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  const url = new URL(context.request.url)

  const statusParam = url.searchParams.get('status')
  const allowedStatus = new Set(['draft', 'published', 'retracted'])
  if (statusParam && !allowedStatus.has(statusParam)) {
    return jsonError(400, 'invalid_status', '?status= must be draft|published|retracted.')
  }

  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw ? Number(limitRaw) : undefined
  if (limitRaw && (!Number.isFinite(limit) || limit! < 1)) {
    return jsonError(400, 'invalid_limit', '?limit= must be a positive integer.')
  }

  const options: ListOptions = {
    status: (statusParam as ListOptions['status']) ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
    limit,
  }

  const { datasets, next_cursor } = await listDatasetsForPublisher(
    context.env.CATALOG_DB!,
    publisher,
    options,
  )
  return new Response(JSON.stringify({ datasets, next_cursor }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

export const onRequestPost: PagesFunction<CatalogEnv> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'Request body must be an object.')
  }
  const result = await createDataset(context.env, publisher, body as Record<string, unknown>)
  if (!result.ok) return validationFailure(result.errors, result.status)
  return new Response(JSON.stringify({ dataset: result.dataset }), {
    status: 201,
    headers: { 'Content-Type': CONTENT_TYPE, Location: `/api/v1/publish/datasets/${result.dataset.id}` },
  })
}
