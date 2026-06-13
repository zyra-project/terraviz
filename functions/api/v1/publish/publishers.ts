/**
 * /api/v1/publish/publishers
 *
 * GET → List publisher accounts for the admin Users tab. Supports
 *       `?status=`, `?role=`, `?q=` (email / display-name substring),
 *       `?cursor=`, and `?limit=`. Returns
 *       `{ publishers, next_cursor }`.
 *
 * Authorisation: admin-only. Unlike the operator-curation routes
 * (which gate on `isPrivileged`), user administration gates on the
 * strict `isAdmin` so service tokens cannot manage other publishers.
 * 403 `forbidden_role` otherwise.
 */

import type { CatalogEnv } from '../_lib/env'
import type { PublisherData } from './_middleware'
import { isAdmin, PUBLISHER_STATUSES } from '../_lib/publisher-store'
import { listPublishers } from '../_lib/publisher-mutations'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isAdmin(publisher)) {
    return jsonError(403, 'forbidden_role', 'User administration is restricted to admins.')
  }

  const url = new URL(context.request.url)

  const statusParam = url.searchParams.get('status')
  if (statusParam && !(PUBLISHER_STATUSES as readonly string[]).includes(statusParam)) {
    return jsonError(400, 'invalid_status', `?status= must be ${PUBLISHER_STATUSES.join('|')}.`)
  }

  const roleParam = url.searchParams.get('role')

  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw ? Number(limitRaw) : undefined
  if (
    limitRaw &&
    (!/^[0-9]+$/.test(limitRaw) || !Number.isFinite(limit) || !Number.isInteger(limit) || limit! < 1)
  ) {
    return jsonError(400, 'invalid_limit', '?limit= must be a positive integer.')
  }

  const { publishers, next_cursor } = await listPublishers(context.env.CATALOG_DB!, {
    status: statusParam ?? undefined,
    role: roleParam ?? undefined,
    q: url.searchParams.get('q') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
    limit,
  })

  return new Response(JSON.stringify({ publishers, next_cursor }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}
