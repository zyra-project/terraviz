/**
 * /api/v1/publish/blog — the blog authoring list + create (Phase 3d;
 * `docs/CURRENT_EVENTS_PLAN.md` §7 companion work).
 *
 * GET  → All posts (drafts included), newest-updated first; optional
 *        `?status=draft|published`. Readable by any active publisher;
 *        each post carries `can_edit` so the portal knows whether to
 *        offer the authoring controls.
 * POST → Create a draft post. Body: `{ title, bodyMd, summary?,
 *        datasetIds?, eventId? }`. Open to any active publisher —
 *        drafting a post makes them its author/owner (only they, or an
 *        admin, may edit it thereafter). 400 `{ errors }` for body
 *        problems, audit-logged (`blog.create`). Posts are born
 *        `draft`; publishing is a separate action on
 *        `/publish/blog/:id` — nothing auto-publishes.
 */

import type { CatalogEnv } from '../_lib/env'
import type { PublisherData } from './_middleware'
import { writeAuditEvent } from '../_lib/audit-store'
import {
  canMutateBlogPost,
  insertBlogPost,
  listBlogPosts,
  toPublicPost,
  validateBlogInput,
  type BlogPostStatus,
} from '../_lib/blog-store'
import { can } from '../_lib/capabilities'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const statusParam = new URL(context.request.url).searchParams.get('status')
  let status: BlogPostStatus | undefined
  if (statusParam) {
    if (statusParam !== 'draft' && statusParam !== 'published') {
      return jsonError(400, 'invalid_status', `Unknown status filter: ${statusParam}`)
    }
    status = statusParam
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  const rows = await listBlogPosts(context.env.CATALOG_DB, { status })
  // Stamp per-post `can_edit` so the portal only offers the authoring
  // controls on posts the caller may mutate (their own, or any as an
  // admin). The whole list is readable regardless.
  const posts = rows.map(row => ({
    ...toPublicPost(row),
    can_edit: canMutateBlogPost(publisher, row),
  }))
  return new Response(JSON.stringify({ posts }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

export const onRequestPost: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  // Any authoring role may create a draft; `insertBlogPost` stamps them
  // as author, and only the author (or an editor/admin) may edit it
  // after. Reviewers (read-only) are refused here.
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!can(publisher, 'content.create')) {
    return jsonError(403, 'forbidden_role', 'Creating blog posts requires an authoring role.')
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

  const row = await insertBlogPost(context.env.CATALOG_DB, publisher, validation.value)

  await writeAuditEvent(context.env.CATALOG_DB, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'blog.create',
    subject_kind: 'blog_post',
    subject_id: row.id,
    metadata_json: JSON.stringify({ slug: row.slug, datasets: validation.value.datasetIds.length }),
  })

  return new Response(JSON.stringify({ post: toPublicPost(row) }), {
    status: 201,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}
