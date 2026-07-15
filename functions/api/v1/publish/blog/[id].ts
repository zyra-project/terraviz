/**
 * /api/v1/publish/blog/:id — single-post authoring operations
 * (Phase 3d).
 *
 * GET  → The post, drafts included (any active publisher). Carries
 *        `can_edit` so the portal knows whether to offer authoring.
 * PUT  → Update content fields (`{ title, bodyMd, summary?,
 *        datasetIds?, eventId? }`). The slug never changes — published
 *        URLs stay stable across edits. Owner-scoped: only the post's
 *        author (or an admin) may edit.
 * POST → `{ action: 'publish' | 'unpublish' }` — the status
 *        transition. Publish is idempotent and keeps the first
 *        publish time; unpublish returns the post to draft.
 *        Owner-scoped, same rule as PUT.
 *
 * Every write is audit-logged (`blog.update` / `blog.publish` /
 * `blog.unpublish`) and busts the public blog caches so the change is
 * live within a tick (the 60 s TTL is the backstop).
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import type { PublisherRow } from '../../_lib/publisher-store'
import { canOwnOrAny } from '../../_lib/capabilities'
import { writeAuditEvent, type AuditAction } from '../../_lib/audit-store'
import {
  bustBlogCache,
  canMutateBlogPost,
  getBlogPost,
  publishBlogPost,
  toPublicPost,
  unpublishBlogPost,
  updateBlogPost,
  validateBlogInput,
} from '../../_lib/blog-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function paramId(context: Parameters<PagesFunction<CatalogEnv, 'id'>>[0]): string | null {
  const raw = context.params.id
  const id = Array.isArray(raw) ? raw[0] : raw
  return id || null
}

function okPost(row: Parameters<typeof toPublicPost>[0], publisher: PublisherRow): Response {
  return new Response(
    JSON.stringify({ post: { ...toPublicPost(row), can_edit: canMutateBlogPost(publisher, row) } }),
    {
      status: 200,
      headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
    },
  )
}

export const onRequestGet: PagesFunction<CatalogEnv, 'id'> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  const id = paramId(context)
  if (!id) return jsonError(400, 'invalid_request', 'Missing post id.')
  const row = await getBlogPost(context.env.CATALOG_DB, id)
  if (!row) return jsonError(404, 'not_found', `Post ${id} not found.`)
  return okPost(row, publisher)
}

export const onRequestPut: PagesFunction<CatalogEnv, 'id'> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  const id = paramId(context)
  if (!id) return jsonError(400, 'invalid_request', 'Missing post id.')

  // Owner-scoped: only the author (or an admin) may edit. 404 for an
  // unknown post; 403 for one the caller doesn't own.
  const current = await getBlogPost(context.env.CATALOG_DB, id)
  if (!current) return jsonError(404, 'not_found', `Post ${id} not found.`)
  if (!canMutateBlogPost(publisher, current)) {
    return jsonError(403, 'forbidden_owner', 'You can only edit blog posts you authored.')
  }

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }
  const validation = validateBlogInput(body)
  if (!validation.ok) {
    return new Response(JSON.stringify({ errors: validation.errors }), {
      status: 400,
      headers: { 'Content-Type': CONTENT_TYPE },
    })
  }

  const row = await updateBlogPost(context.env.CATALOG_DB, id, validation.value)
  if (!row) return jsonError(404, 'not_found', `Post ${id} not found.`)

  await writeAuditEvent(context.env.CATALOG_DB, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'blog.update',
    subject_kind: 'blog_post',
    subject_id: id,
    metadata_json: JSON.stringify({ slug: row.slug }),
  })
  // A published post's content just changed — refresh the public reads.
  if (row.status === 'published') await bustBlogCache(context.env.CATALOG_KV, row.slug)

  return okPost(row, publisher)
}

export const onRequestPost: PagesFunction<CatalogEnv, 'id'> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  const id = paramId(context)
  if (!id) return jsonError(400, 'invalid_request', 'Missing post id.')

  let body: { action?: unknown }
  try {
    body = (await context.request.json()) as { action?: unknown }
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }
  const action = body.action
  if (action !== 'publish' && action !== 'unpublish') {
    return jsonError(400, 'invalid_action', "`action` must be 'publish' or 'unpublish'.")
  }

  const existing = await getBlogPost(context.env.CATALOG_DB, id)
  if (!existing) return jsonError(404, 'not_found', `Post ${id} not found.`)
  // Publishing is a privilege above editing: the author (own) or an
  // editor/admin (any) may (un)publish. A contributor can draft + edit
  // its own post but cannot publish it.
  if (!canOwnOrAny(publisher, existing.author_id, 'content.publish.own', 'content.publish.any')) {
    // Distinguish the two failure modes: the owner who simply lacks a
    // publishing capability (e.g. a contributor) is a role problem;
    // a non-owner without `content.publish.any` is an ownership problem.
    const isOwner = existing.author_id === publisher.id
    return jsonError(
      403,
      isOwner ? 'forbidden_role' : 'forbidden_owner',
      'Publishing a blog post requires a publishing role.',
    )
  }

  const row =
    action === 'publish'
      ? await publishBlogPost(context.env.CATALOG_DB, id)
      : await unpublishBlogPost(context.env.CATALOG_DB, id)
  if (!row) return jsonError(404, 'not_found', `Post ${id} not found.`)

  const auditAction: AuditAction = action === 'publish' ? 'blog.publish' : 'blog.unpublish'
  await writeAuditEvent(context.env.CATALOG_DB, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: auditAction,
    subject_kind: 'blog_post',
    subject_id: id,
    metadata_json: JSON.stringify({ slug: row.slug }),
  })
  await bustBlogCache(context.env.CATALOG_KV, row.slug)

  return okPost(row, publisher)
}
